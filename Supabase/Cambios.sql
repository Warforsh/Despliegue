-- ====================================================================
-- MIGRACIÓN SEGURA: Fase 1 - Gestión de Usuarios (Invitación de Personal)
-- ADVERTENCIA: Este script es 100% ADITIVO y NO DESTRUCTIVO.
-- No elimina datos, tablas ni políticas existentes. Es idempotente.
-- ====================================================================

-- 1. Crear tabla de invitaciones de personal (solo admins gestionan)
-- 'if not exists' garantiza que no fallará si ya se ejecutó antes
create table if not exists public.staff_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  full_name text not null,
  role text not null check (role in ('admin','doctor','nurse','pharmacist','cashier')),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- 2. Habilitar RLS en la nueva tabla (inofensivo si ya está habilitado)
alter table public.staff_invites enable row level security;

-- 3. Políticas de seguridad para invitaciones 
-- (Se hace drop + create para garantizar idempotencia sin duplicar políticas)
drop policy if exists "Solo admins pueden ver invitaciones" on public.staff_invites;
create policy "Solo admins pueden ver invitaciones" on public.staff_invites for select to authenticated using (has_role(array['admin']));

drop policy if exists "Solo admins pueden crear invitaciones" on public.staff_invites;
create policy "Solo admins pueden crear invitaciones" on public.staff_invites for insert to authenticated with check (has_role(array['admin']));

drop policy if exists "Solo admins pueden eliminar invitaciones" on public.staff_invites;
create policy "Solo admins pueden eliminar invitaciones" on public.staff_invites for delete to authenticated using (has_role(array['admin']));

-- 4. Actualizar el trigger de registro para respetar invitaciones (NO DESTRUCTIVO)
-- Si el correo está invitado, obtiene el rol de personal. Si no, cae a 'patient' (comportamiento original intacto).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role text;
begin
  -- Verificar si el correo tiene una invitación pendiente
  select role into v_role from public.staff_invites where lower(email) = lower(new.email);
  
  -- Asignar rol: el de la invitación o 'patient' por defecto (comportamiento original)
  v_role := coalesce(v_role, 'patient');
  
  -- Insertar perfil con el rol correcto (explícito, compatible con tu schema)
  insert into public.profiles(id, full_name, email, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email, v_role);
  
  -- Consumir la invitación para evitar reutilización (solo si era personal)
  if v_role != 'patient' then
    delete from public.staff_invites where lower(email) = lower(new.email);
  end if;

  -- Vincular expediente existente si el correo coincide (Lógica original 100% preservada)
  update public.patients set user_id = new.id
   where user_id is null and email is not null and lower(email) = lower(new.email);
   
  return new;
end $$;

-- NOTA: La tabla `audit_logs` y sus políticas RLS YA existen en tu schema.sql actual,
-- por lo que NO se incluyen aquí para evitar cualquier conflicto de duplicación.

-- ====================================================================
-- MIGRACIÓN SEGURA: Fase 2 - Cadena de Suministro Médico
-- ADVERTENCIA: Este script es 100% ADITIVO y NO DESTRUCTIVO.
-- ====================================================================

-- 1. Tabla de Lotes de Productos (Trazabilidad y Vencimientos)
create table if not exists public.product_batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  batch_number text not null,
  expiration_date date not null,
  quantity int not null check (quantity >= 0),
  remaining_quantity int not null check (remaining_quantity >= 0),
  supplier_id uuid,
  purchase_price numeric(10,2) not null default 0,
  received_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique(product_id, batch_number)
);
create index idx_batches_product on public.product_batches(product_id);
create index idx_batches_expiration on public.product_batches(expiration_date);

-- 2. Tabla de Movimientos de Inventario (Trazabilidad completa)
create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  batch_id uuid references public.product_batches(id) on delete set null,
  movement_type text not null check (movement_type in ('entrada', 'salida', 'ajuste', 'devolucion')),
  quantity int not null check (quantity > 0),
  reason text not null,
  reference_id uuid, -- prescription_id, purchase_order_id, etc.
  reference_type text, -- 'prescription', 'purchase_order', 'adjustment'
  performed_by uuid default auth.uid(),
  performed_at timestamptz not null default now()
);
create index idx_movements_product on public.inventory_movements(product_id);
create index idx_movements_date on public.inventory_movements(performed_at);

-- 3. Tabla de Proveedores
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact_name text,
  phone text,
  email text,
  address text,
  tax_id text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 4. Tabla de Órdenes de Compra
create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default ('OC-' || lpad(nextval('public.invoice_seq')::text, 6, '0')),
  supplier_id uuid not null references public.suppliers(id),
  items jsonb not null default '[]', -- [{product_id, product_name, quantity, unit_price, batch_number, expiration_date}]
  total numeric(10,2) not null check (total >= 0),
  status text not null default 'pendiente' check (status in ('pendiente', 'recibida', 'cancelada')),
  received_at timestamptz,
  received_by uuid,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- 5. Agregar supplier_id a product_batches
alter table public.product_batches 
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;

-- 6. RLS para nuevas tablas
alter table public.product_batches enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;

-- Políticas: product_batches
drop policy if exists "Lotes visibles para personal autorizado" on public.product_batches;
create policy "Lotes visibles para personal autorizado" on public.product_batches for select to authenticated 
  using (has_role(array['admin','pharmacist','doctor','nurse']));

drop policy if exists "Lotes insertables por admin/farmacia" on public.product_batches;
create policy "Lotes insertables por admin/farmacia" on public.product_batches for insert to authenticated 
  with check (has_role(array['admin','pharmacist']));

drop policy if exists "Lotes actualizables por admin/farmacia" on public.product_batches;
create policy "Lotes actualizables por admin/farmacia" on public.product_batches for update to authenticated 
  using (has_role(array['admin','pharmacist'])) with check (has_role(array['admin','pharmacist']));

-- Políticas: inventory_movements
drop policy if exists "Movimientos visibles para personal autorizado" on public.inventory_movements;
create policy "Movimientos visibles para personal autorizado" on public.inventory_movements for select to authenticated 
  using (has_role(array['admin','pharmacist','doctor','nurse']));

drop policy if exists "Movimientos insertables por personal autorizado" on public.inventory_movements;
create policy "Movimientos insertables por personal autorizado" on public.inventory_movements for insert to authenticated 
  with check (has_role(array['admin','pharmacist','doctor','nurse']));

-- Políticas: suppliers
drop policy if exists "Proveedores visibles para personal autorizado" on public.suppliers;
create policy "Proveedores visibles para personal autorizado" on public.suppliers for select to authenticated 
  using (has_role(array['admin','pharmacist']));

drop policy if exists "Proveedores gestionables por admin" on public.suppliers;
create policy "Proveedores gestionables por admin" on public.suppliers for all to authenticated 
  using (has_role(array['admin'])) with check (has_role(array['admin']));

-- Políticas: purchase_orders
drop policy if exists "Órdenes visibles para personal autorizado" on public.purchase_orders;
create policy "Órdenes visibles para personal autorizado" on public.purchase_orders for select to authenticated 
  using (has_role(array['admin','pharmacist']));

drop policy if exists "Órdenes gestionables por admin/farmacia" on public.purchase_orders;
create policy "Órdenes gestionables por admin/farmacia" on public.purchase_orders for all to authenticated 
  using (has_role(array['admin','pharmacist'])) with check (has_role(array['admin','pharmacist']));

-- 7. Función mejorada de dispensación con lotes (FEFO: First Expired, First Out)
create or replace function public.dispense_prescription(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare 
  it record; 
  rx prescriptions;
  batch record;
  remaining int;
begin
  -- Validación de permisos
  if not has_role(array['admin','pharmacist']) then 
    raise exception 'No autorizado'; 
  end if;
  
  -- Obtener receta con bloqueo
  select * into rx from prescriptions where id = p_id for update;
  if not found then 
    raise exception 'Receta no encontrada'; 
  end if;
  if rx.status = 'dispensada' then 
    raise exception 'La receta ya fue dispensada'; 
  end if;
  
  -- Procesar cada item de la receta
  for it in select * from prescription_items where prescription_id = p_id and product_id is not null loop
    remaining := it.quantity;
    
    -- FEFO: Usar lotes ordenados por fecha de vencimiento (más próximo primero)
    for batch in 
      select * from product_batches 
      where product_id = it.product_id 
        and remaining_quantity > 0 
        and expiration_date >= current_date
      order by expiration_date asc, received_at asc
    loop
      if remaining <= 0 then exit; end if;
      
      -- Calcular cuánto tomar de este lote
      if batch.remaining_quantity >= remaining then
        -- El lote tiene suficiente
        update product_batches 
        set remaining_quantity = remaining_quantity - remaining 
        where id = batch.id;
        
        -- Registrar movimiento
        insert into inventory_movements(product_id, batch_id, movement_type, quantity, reason, reference_id, reference_type)
        values (it.product_id, batch.id, 'salida', remaining, 'Dispensación de receta', p_id, 'prescription');
        
        remaining := 0;
      else
        -- Tomar todo lo disponible del lote
        update product_batches 
        set remaining_quantity = 0 
        where id = batch.id;
        
        insert into inventory_movements(product_id, batch_id, movement_type, quantity, reason, reference_id, reference_type)
        values (it.product_id, batch.id, 'salida', batch.remaining_quantity, 'Dispensación de receta', p_id, 'prescription');
        
        remaining := remaining - batch.remaining_quantity;
      end if;
    end loop;
    
    -- Si aún queda cantidad pendiente, no hay stock suficiente
    if remaining > 0 then
      raise exception 'Stock insuficiente para % (faltan % unidades)', it.name, remaining;
    end if;
    
    -- Actualizar stock total del producto
    update products 
    set stock = stock - it.quantity 
    where id = it.product_id;
  end loop;
  
  -- Marcar receta como dispensada
  update prescriptions 
  set status = 'dispensada', dispensed_by = auth.uid(), dispensed_at = now() 
  where id = p_id;
  
  -- Auditoría
  insert into audit_logs(user_id, action, entity, entity_id, detail)
  values (auth.uid(), 'dispense', 'prescription', p_id,
    jsonb_build_object('items', (select jsonb_agg(jsonb_build_object('name', name, 'qty', quantity))
                                  from prescription_items where prescription_id = p_id)));
end $$;

-- 8. Función para registrar entrada de inventario (compra)
create or replace function public.receive_purchase_order(p_order_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare 
  ord record;
  item jsonb;
  batch_id uuid;
begin
  if not has_role(array['admin','pharmacist']) then 
    raise exception 'No autorizado'; 
  end if;
  
  select * into ord from purchase_orders where id = p_order_id for update;
  if not found then 
    raise exception 'Orden no encontrada'; 
  end if;
  if ord.status = 'recibida' then 
    raise exception 'La orden ya fue recibida'; 
  end if;
  
  -- Procesar cada item de la orden
  for item in select * from jsonb_array_elements(ord.items) loop
    -- Crear o actualizar lote
    insert into product_batches(product_id, batch_number, expiration_date, quantity, remaining_quantity, supplier_id, purchase_price)
    values (
      (item->>'product_id')::uuid,
      item->>'batch_number',
      (item->>'expiration_date')::date,
      (item->>'quantity')::int,
      (item->>'quantity')::int,
      ord.supplier_id,
      (item->>'unit_price')::numeric
    )
    on conflict (product_id, batch_number) 
    do update set 
      quantity = product_batches.quantity + (item->>'quantity')::int,
      remaining_quantity = product_batches.remaining_quantity + (item->>'quantity')::int
    returning id into batch_id;
    
    -- Actualizar stock total del producto
    update products 
    set stock = stock + (item->>'quantity')::int
    where id = (item->>'product_id')::uuid;
    
    -- Registrar movimiento
    insert into inventory_movements(product_id, batch_id, movement_type, quantity, reason, reference_id, reference_type)
    values ((item->>'product_id')::uuid, batch_id, 'entrada', (item->>'quantity')::int, 'Recepción de orden de compra', p_order_id, 'purchase_order');
  end loop;
  
  -- Marcar orden como recibida
  update purchase_orders 
  set status = 'recibida', received_at = now(), received_by = auth.uid()
  where id = p_order_id;
  
  -- Auditoría
  insert into audit_logs(user_id, action, entity, entity_id, detail)
  values (auth.uid(), 'receive', 'purchase_order', p_order_id, jsonb_build_object('total', ord.total));
end $$;

-- Permisos para nuevas funciones
revoke execute on function public.receive_purchase_order(uuid) from public, anon;
grant execute on function public.receive_purchase_order(uuid) to authenticated;


-- ====================================================================
-- MIGRACIÓN SEGURA: Fase 3 - Administración y Finanzas
-- ADVERTENCIA: Este script es 100% ADITIVO y NO DESTRUCTIVO.
-- ====================================================================

-- 1. Tabla de Documentos Adjuntos (Gestión Documental con Auditoría)
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('patient', 'consultation', 'invoice', 'appointment', 'product')),
  entity_id uuid not null,
  filename text not null,
  file_type text not null check (file_type in ('pdf', 'jpg', 'png', 'docx', 'xlsx')),
  file_size int not null check (file_size > 0),
  storage_path text not null, -- Ruta en Supabase Storage
  description text,
  uploaded_by uuid default auth.uid(),
  uploaded_at timestamptz not null default now(),
  is_confidential boolean not null default false,
  checksum text -- Para integridad de archivos
);
create index idx_documents_entity on public.documents(entity_type, entity_id);
create index idx_documents_uploaded on public.documents(uploaded_at);

-- 2. Tabla de Reportes Generados (Auditoría de Exportaciones)
create table if not exists public.report_exports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null check (report_type in ('financial', 'clinical', 'inventory', 'patients', 'appointments')),
  filters jsonb not null default '{}',
  generated_by uuid default auth.uid(),
  generated_at timestamptz not null default now(),
  row_count int not null,
  file_format text not null check (file_format in ('csv', 'xlsx', 'pdf')),
  storage_path text,
  metadata jsonb not null default '{}' -- Incluye marca de agua, hash, etc.
);
create index idx_reports_generated on public.report_exports(generated_at);

-- 3. Mejorar tabla de facturas con campos de seguridad financiera
alter table public.invoices 
  add column if not exists payment_reference text, -- Referencia única de transacción
  add column if not exists card_last_four text check (card_last_four ~ '^[0-9]{4}$'), -- Solo últimos 4 dígitos (PCI DSS)
  add column if not exists payment_gateway text, -- Stripe, PayPal, etc.
  add column if not exists refund_amount numeric(10,2) default 0 check (refund_amount >= 0),
  add column if not exists refund_reason text,
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by uuid references auth.users(id);

-- 4. Tabla de Cierres de Caja Detallados (Auditoría completa)
create table if not exists public.cash_closures_detail (
  id uuid primary key default gen_random_uuid(),
  closure_id uuid not null references public.cash_closures(id) on delete cascade,
  transaction_type text not null check (transaction_type in ('venta', 'devolucion', 'ajuste', 'retiro')),
  amount numeric(10,2) not null,
  payment_method text check (payment_method in ('efectivo', 'tarjeta', 'mixto')),
  reference_id uuid, -- invoice_id, etc.
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index idx_closure_detail_closure on public.cash_closures_detail(closure_id);

-- 5. RLS para nuevas tablas
alter table public.documents enable row level security;
alter table public.report_exports enable row level security;
alter table public.cash_closures_detail enable row level security;

-- Políticas: documents
drop policy if exists "Documentos visibles según entidad" on public.documents;
create policy "Documentos visibles según entidad" on public.documents for select to authenticated 
  using (
    -- Admin ve todo
    has_role(array['admin'])
    -- Médicos ven documentos de sus consultas
    or (entity_type = 'consultation' and exists (
      select 1 from consultations c where c.id = entity_id and c.doctor_id = auth.uid()
    ))
    -- Pacientes ven sus propios documentos (no confidenciales)
    or (entity_type = 'patient' and not is_confidential and exists (
      select 1 from patients p where p.id = entity_id and p.user_id = auth.uid()
    ))
    -- Farmacia ve documentos de productos
    or (entity_type = 'product' and has_role(array['admin','pharmacist']))
  );

drop policy if exists "Documentos insertables por personal autorizado" on public.documents;
create policy "Documentos insertables por personal autorizado" on public.documents for insert to authenticated 
  with check (
    has_role(array['admin','doctor','nurse','pharmacist'])
    or (entity_type = 'patient' and has_role(array['patient']) and uploaded_by = auth.uid())
  );

drop policy if exists "Documentos eliminables por admin" on public.documents;
create policy "Documentos eliminables por admin" on public.documents for delete to authenticated 
  using (has_role(array['admin']));

-- Políticas: report_exports
drop policy if exists "Reportes visibles para admin" on public.report_exports;
create policy "Reportes visibles para admin" on public.report_exports for select to authenticated 
  using (has_role(array['admin']));

drop policy if exists "Reportes insertables por personal autorizado" on public.report_exports;
create policy "Reportes insertables por personal autorizado" on public.report_exports for insert to authenticated 
  with check (has_role(array['admin','doctor','pharmacist','cashier']));

-- Políticas: cash_closures_detail
drop policy if exists "Detalle de cierres visible para admin/caja" on public.cash_closures_detail;
create policy "Detalle de cierres visible para admin/caja" on public.cash_closures_detail for select to authenticated 
  using (has_role(array['admin','cashier']));

drop policy if exists "Detalle de cierres insertable por admin/caja" on public.cash_closures_detail;
create policy "Detalle de cierres insertable por admin/caja" on public.cash_closures_detail for insert to authenticated 
  with check (has_role(array['admin','cashier']));

-- 6. Función para generar reporte financiero con auditoría
create or replace function public.generate_financial_report(
  p_from date,
  p_to date,
  p_format text default 'csv'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_report_id uuid;
  v_data jsonb;
  v_row_count int;
begin
  if not has_role(array['admin','cashier']) then
    raise exception 'No autorizado';
  end if;

  -- Generar datos del reporte
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'invoices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'number', number,
        'date', created_at,
        'patient', (select first_name || ' ' || last_name from patients where id = patient_id),
        'total', total,
        'method', method,
        'status', status
      ))
      from invoices
      where created_at::date between p_from and p_to
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'total_invoices', (select count(*) from invoices where created_at::date between p_from and p_to),
      'total_amount', (select coalesce(sum(total), 0) from invoices where created_at::date between p_from and p_to and status = 'pagada'),
      'cash_total', (select coalesce(sum(total), 0) from invoices where created_at::date between p_from and p_to and status = 'pagada' and method = 'efectivo'),
      'card_total', (select coalesce(sum(total), 0) from invoices where created_at::date between p_from and p_to and status = 'pagada' and method = 'tarjeta')
    )
  ) into v_data;

  -- Contar filas
  select count(*) into v_row_count from jsonb_array_elements(v_data->'invoices');

  -- Registrar auditoría del reporte
  insert into report_exports(report_type, filters, row_count, file_format, metadata)
  values (
    'financial',
    jsonb_build_object('from', p_from, 'to', p_to),
    v_row_count,
    p_format,
    jsonb_build_object(
      'generated_by', auth.uid(),
      'generated_at', now(),
      'watermark', 'Centro Médico Premier - Documento Confidencial',
      'checksum', md5(v_data::text)
    )
  ) returning id into v_report_id;

  -- Auditoría adicional
  insert into audit_logs(user_id, action, entity, entity_id, detail)
  values (auth.uid(), 'generate_report', 'report_exports', v_report_id, 
    jsonb_build_object('type', 'financial', 'rows', v_row_count));

  return jsonb_build_object('report_id', v_report_id, 'data', v_data);
end $$;

-- 7. Función para generar reporte clínico con auditoría
create or replace function public.generate_clinical_report(
  p_from date,
  p_to date,
  p_doctor_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_report_id uuid;
  v_data jsonb;
  v_row_count int;
begin
  if not has_role(array['admin','doctor']) then
    raise exception 'No autorizado';
  end if;

  -- Generar datos del reporte
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'consultations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'date', a.starts_at,
        'patient', (select first_name || ' ' || last_name from patients where id = c.patient_id),
        'doctor', (select full_name from profiles where id = c.doctor_id),
        'diagnosis', c.diagnosis,
        'finalized', c.finalized
      ))
      from consultations c
      join appointments a on a.id = c.appointment_id
      where a.starts_at::date between p_from and p_to
        and (p_doctor_id is null or c.doctor_id = p_doctor_id)
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'total_consultations', (
        select count(*) from consultations c
        join appointments a on a.id = c.appointment_id
        where a.starts_at::date between p_from and p_to
          and (p_doctor_id is null or c.doctor_id = p_doctor_id)
      )
    )
  ) into v_data;

  -- Contar filas
  select count(*) into v_row_count from jsonb_array_elements(v_data->'consultations');

  -- Registrar auditoría del reporte
  insert into report_exports(report_type, filters, row_count, file_format, metadata)
  values (
    'clinical',
    jsonb_build_object('from', p_from, 'to', p_to, 'doctor_id', p_doctor_id),
    v_row_count,
    'pdf',
    jsonb_build_object(
      'generated_by', auth.uid(),
      'generated_at', now(),
      'watermark', 'Centro Médico Premier - Historia Clínica Confidencial',
      'checksum', md5(v_data::text)
    )
  ) returning id into v_report_id;

  -- Auditoría adicional
  insert into audit_logs(user_id, action, entity, entity_id, detail)
  values (auth.uid(), 'generate_report', 'report_exports', v_report_id, 
    jsonb_build_object('type', 'clinical', 'rows', v_row_count));

  return jsonb_build_object('report_id', v_report_id, 'data', v_data);
end $$;

-- Permisos para nuevas funciones
revoke execute on function public.generate_financial_report(date, date, text), 
  public.generate_clinical_report(date, date, uuid) from public, anon;
grant execute on function public.generate_financial_report(date, date, text), 
  public.generate_clinical_report(date, date, uuid) to authenticated;