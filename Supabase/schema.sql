-- =====================================================================
-- CENTRO MÉDICO PREMIER — Esquema Supabase (ejecutar completo en SQL Editor)
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------- TABLAS ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text,
  role text not null default 'patient' check (role in ('admin','doctor','nurse','patient','pharmacist','cashier')),
  created_at timestamptz not null default now()
);

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  dpi text not null unique check (dpi ~ '^[0-9]{13}$'),
  first_name text not null,
  last_name text not null,
  birth_date date not null,
  blood_type text check (blood_type in ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  phone text,
  email text,
  emergency_name text,
  emergency_phone text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index patients_user_uq on public.patients(user_id) where user_id is not null;
create index patients_name_idx on public.patients(lower(last_name), lower(first_name));

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  doctor_id uuid not null references public.profiles(id),
  starts_at timestamptz not null,
  status text not null default 'programada' check (status in ('pendiente','programada','confirmada','en_espera','atendida','cancelada','ausente')),
  reason text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (extract(minute from starts_at at time zone 'UTC') in (0,30))   -- bloques de 30 min
);
-- Un médico no puede tener dos citas activas en el mismo horario
create unique index appointments_slot_uq on public.appointments(doctor_id, starts_at)
  where status not in ('cancelada','ausente');

create table public.consultations (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references public.appointments(id) on delete cascade,
  patient_id uuid not null references public.patients(id),
  doctor_id uuid not null references public.profiles(id),
  blood_pressure text, temperature numeric(4,1), pulse int, weight_kg numeric(5,2), height_cm numeric(5,1),
  reason text, diagnosis text, plan text,
  finalized boolean not null default false,
  finalized_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  stock int not null default 0 check (stock >= 0),
  min_stock int not null default 0,
  price numeric(10,2) not null default 0
);

create table public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references public.consultations(id) on delete cascade,
  patient_id uuid not null references public.patients(id),
  doctor_id uuid not null references public.profiles(id),
  status text not null default 'pendiente' check (status in ('pendiente','dispensada')),
  dispensed_by uuid references public.profiles(id),
  dispensed_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.prescription_items (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references public.prescriptions(id) on delete cascade,
  product_id uuid references public.products(id),
  name text not null, dose text, frequency text, duration text,
  quantity int not null check (quantity > 0)
);

create sequence public.invoice_seq;
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique default ('F-' || lpad(nextval('public.invoice_seq')::text, 6, '0')),
  patient_id uuid not null references public.patients(id),
  consultation_id uuid references public.consultations(id),
  prescription_ids uuid[] not null default '{}',
  items jsonb not null default '[]',
  total numeric(10,2) not null check (total >= 0),
  method text check (method in ('efectivo','tarjeta')),
  status text not null default 'pendiente' check (status in ('pagada','pendiente')),
  paid_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (status = 'pendiente' or (method is not null and paid_at is not null))
);
create table public.cash_closures (
  id uuid primary key default gen_random_uuid(),
  closure_date date not null unique,
  total numeric(10,2) not null, cash_total numeric(10,2) not null default 0, card_total numeric(10,2) not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create table public.audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------- FUNCIONES AUXILIARES ----------
create or replace function public.has_role(roles text[]) returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role = any(roles) from profiles where id = auth.uid()), false) $$;

create or replace function public.my_patient_id() returns uuid
language sql stable security definer set search_path = public as
$$ select id from patients where user_id = auth.uid() limit 1 $$;

-- Al registrarse: crea perfil con rol 'patient' (el rol NUNCA viene del cliente)
-- y vincula expediente existente si el correo coincide (requiere confirmación de correo activa).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles(id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), new.email);
  update patients set user_id = new.id
   where user_id is null and email is not null and lower(email) = lower(new.email);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Bloqueo de consulta finalizada (solo admin puede modificar/desbloquear)
create or replace function public.lock_finalized() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.finalized and not has_role(array['admin']) then
    raise exception 'La consulta está finalizada y bloqueada. Solo un administrador puede desbloquearla.';
  end if;
  return new;
end $$;
create trigger consultations_lock before update on public.consultations
  for each row execute function public.lock_finalized();

-- Auditoría automática de escrituras
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
  insert into audit_logs(user_id, action, entity, entity_id, detail)
  values (auth.uid(), lower(tg_op), tg_table_name, (r->>'id')::uuid,
          case when tg_table_name in ('consultations','invoices','appointments')
               then jsonb_build_object('status', coalesce(r->>'status', r->>'finalized')) else '{}'::jsonb end);
  return null;
end $$;
do $$ declare t text; begin
  foreach t in array array['patients','appointments','consultations','products','invoices','cash_closures'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function public.audit_row()', t);
  end loop; end $$;

-- ---------- RPC ----------
create or replace function public.taken_slots(p_doctor uuid, p_from timestamptz, p_to timestamptz)
returns setof timestamptz language sql stable security definer set search_path = public as
$$ select starts_at from appointments
   where doctor_id = p_doctor and starts_at >= p_from and starts_at < p_to
     and status not in ('cancelada','ausente') $$;

create or replace function public.dispense_prescription(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare it record; rx prescriptions;
begin
  if not has_role(array['admin','pharmacist']) then raise exception 'No autorizado'; end if;
  select * into rx from prescriptions where id = p_id for update;
  if not found then raise exception 'Receta no encontrada'; end if;
  if rx.status = 'dispensada' then raise exception 'La receta ya fue dispensada'; end if;
  for it in select * from prescription_items where prescription_id = p_id and product_id is not null loop
    update products set stock = stock - it.quantity where id = it.product_id and stock >= it.quantity;
    if not found then raise exception 'Stock insuficiente para %', it.name; end if;
  end loop;
  update prescriptions set status = 'dispensada', dispensed_by = auth.uid(), dispensed_at = now() where id = p_id;
  insert into audit_logs(user_id, action, entity, entity_id, detail)
  values (auth.uid(), 'dispense', 'prescription', p_id,
    jsonb_build_object('items', (select jsonb_agg(jsonb_build_object('name', name, 'qty', quantity))
                                  from prescription_items where prescription_id = p_id)));
end $$;

-- Conceptos facturables SIN exponer datos clínicos al cajero
create or replace function public.billable_items(p_patient uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_role(array['admin','cashier']) then raise exception 'No autorizado'; end if;
  return jsonb_build_object(
    'consultations', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'date', a.starts_at, 'doctor', d.full_name))
      from consultations c join appointments a on a.id = c.appointment_id join profiles d on d.id = c.doctor_id
      where c.patient_id = p_patient and c.finalized
        and not exists (select 1 from invoices i where i.consultation_id = c.id)), '[]'::jsonb),
    'prescriptions', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'date', r.dispensed_at, 'items', (
        select jsonb_agg(jsonb_build_object('name', pi.name, 'qty', pi.quantity, 'price', coalesce(pr.price, 0)))
        from prescription_items pi left join products pr on pr.id = pi.product_id where pi.prescription_id = r.id)))
      from prescriptions r
      where r.patient_id = p_patient and r.status = 'dispensada'
        and not exists (select 1 from invoices i where r.id = any(i.prescription_ids))), '[]'::jsonb));
end $$;

revoke execute on function public.dispense_prescription(uuid), public.billable_items(uuid),
  public.taken_slots(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.dispense_prescription(uuid), public.billable_items(uuid),
  public.taken_slots(uuid, timestamptz, timestamptz) to authenticated;
grant usage on sequence public.invoice_seq to authenticated;

-- ---------- ROW LEVEL SECURITY ----------
alter table public.profiles enable row level security;
alter table public.patients enable row level security;
alter table public.appointments enable row level security;
alter table public.consultations enable row level security;
alter table public.products enable row level security;
alter table public.prescriptions enable row level security;
alter table public.prescription_items enable row level security;
alter table public.invoices enable row level security;
alter table public.cash_closures enable row level security;
alter table public.audit_logs enable row level security;

-- profiles (nombres/roles visibles a usuarios autenticados; solo admin modifica)
create policy profiles_sel on public.profiles for select to authenticated using (true);
create policy profiles_upd on public.profiles for update to authenticated using (has_role(array['admin'])) with check (has_role(array['admin']));

-- patients
create policy pat_sel on public.patients for select to authenticated
  using (user_id = auth.uid() or has_role(array['admin','doctor','nurse','cashier','pharmacist']));
create policy pat_ins on public.patients for insert to authenticated
  with check (has_role(array['admin','doctor','nurse']) or (user_id = auth.uid() and has_role(array['patient'])));
create policy pat_upd on public.patients for update to authenticated
  using (has_role(array['admin','doctor','nurse'])) with check (has_role(array['admin','doctor','nurse']));
create policy pat_del on public.patients for delete to authenticated using (has_role(array['admin']));

-- appointments
create policy apt_sel on public.appointments for select to authenticated
  using (has_role(array['admin','nurse']) or doctor_id = auth.uid() or patient_id = my_patient_id());
create policy apt_ins on public.appointments for insert to authenticated
  with check (has_role(array['admin','nurse'])
    or (has_role(array['doctor']) and doctor_id = auth.uid())
    or (patient_id = my_patient_id() and status = 'pendiente'));
create policy apt_upd on public.appointments for update to authenticated
  using (has_role(array['admin','nurse']) or (has_role(array['doctor']) and doctor_id = auth.uid()))
  with check (has_role(array['admin','nurse']) or (has_role(array['doctor']) and doctor_id = auth.uid()));
create policy apt_del on public.appointments for delete to authenticated using (has_role(array['admin']));

-- consultations
create policy con_sel on public.consultations for select to authenticated
  using (has_role(array['admin']) or doctor_id = auth.uid() or patient_id = my_patient_id());
create policy con_ins on public.consultations for insert to authenticated
  with check ((has_role(array['admin']) or (has_role(array['doctor']) and doctor_id = auth.uid()))
    and exists (select 1 from appointments a where a.id = appointment_id and a.patient_id = consultations.patient_id
                and a.doctor_id = consultations.doctor_id and a.status in ('confirmada','en_espera')));
create policy con_upd on public.consultations for update to authenticated
  using (has_role(array['admin']) or (has_role(array['doctor']) and doctor_id = auth.uid()))
  with check (has_role(array['admin']) or (has_role(array['doctor']) and doctor_id = auth.uid()));

-- products
create policy prod_sel on public.products for select to authenticated using (has_role(array['admin','pharmacist','doctor','nurse']));
create policy prod_ins on public.products for insert to authenticated with check (has_role(array['admin','pharmacist']));
create policy prod_upd on public.products for update to authenticated using (has_role(array['admin','pharmacist'])) with check (has_role(array['admin','pharmacist']));
create policy prod_del on public.products for delete to authenticated using (has_role(array['admin']));

-- prescriptions (el estado "dispensada" solo cambia vía RPC dispense_prescription)
create policy rx_sel on public.prescriptions for select to authenticated
  using (has_role(array['admin','pharmacist']) or doctor_id = auth.uid() or patient_id = my_patient_id());
create policy rx_ins on public.prescriptions for insert to authenticated
  with check (status = 'pendiente' and (has_role(array['admin'])
    or (has_role(array['doctor']) and doctor_id = auth.uid()
        and exists (select 1 from consultations c where c.id = consultation_id and not c.finalized))));
create policy rxi_sel on public.prescription_items for select to authenticated
  using (exists (select 1 from prescriptions p where p.id = prescription_id));
create policy rxi_ins on public.prescription_items for insert to authenticated
  with check (exists (select 1 from prescriptions p where p.id = prescription_id and p.status = 'pendiente'
    and (has_role(array['admin']) or (has_role(array['doctor']) and p.doctor_id = auth.uid()))));

-- invoices / caja
create policy inv_sel on public.invoices for select to authenticated
  using (has_role(array['admin','cashier']) or patient_id = my_patient_id());
create policy inv_ins on public.invoices for insert to authenticated with check (has_role(array['admin','cashier']));
create policy inv_upd on public.invoices for update to authenticated using (has_role(array['admin','cashier'])) with check (has_role(array['admin','cashier']));
create policy cc_sel on public.cash_closures for select to authenticated using (has_role(array['admin','cashier']));
create policy cc_ins on public.cash_closures for insert to authenticated with check (has_role(array['admin','cashier']));

-- audit_logs: cualquiera inserta SU propio registro de acceso; solo admin lee; nadie edita/borra
create policy aud_ins on public.audit_logs for insert to authenticated with check (user_id = auth.uid());
create policy aud_sel on public.audit_logs for select to authenticated using (has_role(array['admin']));

-- =====================================================================
-- PRIMER ADMINISTRADOR: regístrese en la app y luego ejecute (con su correo):
--   update public.profiles set role = 'admin' where email = 'su-correo@dominio.com';
-- =====================================================================
