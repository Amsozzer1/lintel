-- Two users, a shared room, and a public post.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ada@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com');

insert into public.profiles (id, username) values
  ('11111111-1111-1111-1111-111111111111', 'ada'),
  ('22222222-2222-2222-2222-222222222222', 'bob');

insert into public.rooms (name, created_by) values
  ('general', '11111111-1111-1111-1111-111111111111');

insert into public.room_members (room_id, user_id) values
  (1, '11111111-1111-1111-1111-111111111111'),
  (1, '22222222-2222-2222-2222-222222222222');

insert into public.blog_posts (title, body, published_at) values
  ('Hello', 'Our first post.', now());

insert into public.messages (room_id, author_id, body) values
  (1, '11111111-1111-1111-1111-111111111111', 'hey bob, the launch code is 0000'),
  (1, '22222222-2222-2222-2222-222222222222', 'ha, very funny');

insert into public.direct_messages (sender_id, recipient_id, body) values
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'the acquisition closes friday. do NOT tell anyone'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'my lips are sealed'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'new wifi password is correct-horse-battery-staple');
