create schema if not exists cron;
create table cron.job (jobid bigserial primary key, schedule text not null, command text not null,
  nodename text not null default 'localhost', nodeport int not null default 5432, database text not null default current_database(),
  username text not null default current_user, active boolean not null default true, jobname text);
create table cron.job_run_details (jobid bigint, runid bigserial primary key, job_pid int, database text, username text,
  command text, status text, return_message text, start_time timestamptz, end_time timestamptz);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as
  $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
create function cron.schedule(schedule text, command text) returns bigint language sql as
  $$ insert into cron.job (schedule, command) values (schedule, command) returning jobid $$;
create function cron.schedule_in_database(job_name text, schedule text, command text, database text, username text default null, active boolean default true) returns bigint language sql as
  $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
create function cron.unschedule(job_id bigint) returns boolean language sql as $$ with d as (delete from cron.job where jobid = job_id returning 1) select exists (select 1 from d) $$;
create function cron.unschedule(job_name text) returns boolean language sql as $$ with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
create function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null) returns void language sql as $$ select $$;
