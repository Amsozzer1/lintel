import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export const LEAKY_MESSAGES = `
create table public.messages (
  id bigint generated always as identity primary key,
  room_id bigint not null references public.rooms (id),
  author_id uuid not null references auth.users (id),
  body text not null
);
create policy "anyone can read messages" on public.messages for select using (true);
`;

export const FIXED_MESSAGES = `
create table public.messages (
  id bigint generated always as identity primary key,
  room_id bigint not null references public.rooms (id),
  author_id uuid not null references auth.users (id),
  body text not null
);
create index messages_room_id_idx on public.messages (room_id);
create index messages_author_id_idx on public.messages (author_id);
alter table public.messages enable row level security;
create policy "members read their rooms' messages" on public.messages for select to authenticated
  using (exists (select 1 from public.room_members m
                 where m.room_id = messages.room_id and m.user_id = (select auth.uid())));
`;

/** A temp git repo whose `supabase/` starts as the demo app, committed as `base`. */
export async function demoRepo(): Promise<{
  dir: string;
  commit: (sql: string, name?: string) => Promise<string>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "lintel-repo-"));
  await cp(join(import.meta.dirname, "../../demo/supabase"), join(dir, "supabase"), {
    recursive: true,
  });
  const git = (...args: string[]) => execa("git", args, { cwd: dir });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  await git("tag", "base");
  return {
    dir,
    async commit(sql: string, name = "20260902000000_messages.sql") {
      await mkdir(join(dir, "supabase/migrations"), { recursive: true });
      await writeFile(join(dir, "supabase/migrations", name), sql);
      await git("add", "-A");
      await git("commit", "-q", "-m", name);
      return (await git("rev-parse", "HEAD")).stdout.trim();
    },
  };
}
