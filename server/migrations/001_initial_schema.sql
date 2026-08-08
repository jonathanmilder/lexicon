CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_settings (
  user_id      bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dictionaries text[] NOT NULL DEFAULT '{}',
  usage_guides text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE words (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word           text NOT NULL,
  part_of_speech text,
  pronunciation  text,
  definitions    text[],
  etymology      text,
  usage_note     text,
  examples       text[],
  mnemonics      text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX words_user_word_lower ON words (user_id, lower(word));

CREATE TABLE progress (
  word_id     bigint PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
  ease        real        NOT NULL,
  repetition  integer     NOT NULL,
  next_review timestamptz NOT NULL,
  last_rated  timestamptz
);
