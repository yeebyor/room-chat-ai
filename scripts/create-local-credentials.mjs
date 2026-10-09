// First-time setup only: writes the env files with fresh random tokens and prints the
// SHA-256 hash of each token for registration in chat_private.credentials.
// Usage: node scripts/create-local-credentials.mjs <SUPABASE_URL> <SUPABASE_PUBLISHABLE_KEY>
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const [url, key] = process.argv.slice(2);
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url ?? '') || !key) {
  throw new Error('Usage: node scripts/create-local-credentials.mjs <SUPABASE_URL> <SUPABASE_PUBLISHABLE_KEY>\n'
    + 'Both come from your Supabase project settings (API). Use the publishable key, never the service role key.');
}
const files = ['.env.local', '.env.agents.local', '.env.agent-claude.local', '.env.agent-gpt.local', '.env.agent-gemini.local'];
if (files.some((file) => existsSync(file))) {
  throw new Error('Credentials already exist. Refusing to overwrite them.');
}
const user = randomBytes(32).toString('hex');
const claude = randomBytes(32).toString('hex');
const gpt = randomBytes(32).toString('hex');
const gemini = randomBytes(32).toString('hex');
writeFileSync('.env.local', [`SUPABASE_URL=${url}`, `SUPABASE_PUBLISHABLE_KEY=${key}`, `CHAT_USER_TOKEN=${user}`, ''].join('\n'), { mode: 0o600 });
// The combined file is for the smoke tests; each agent loads only its own file.
writeFileSync('.env.agents.local', `CHAT_CLAUDE_TOKEN=${claude}\nCHAT_GPT_TOKEN=${gpt}\nCHAT_GEMINI_TOKEN=${gemini}\n`, { mode: 0o600 });
writeFileSync('.env.agent-claude.local', `CHAT_CLAUDE_TOKEN=${claude}\n`, { mode: 0o600 });
writeFileSync('.env.agent-gpt.local', `CHAT_GPT_TOKEN=${gpt}\n`, { mode: 0o600 });
writeFileSync('.env.agent-gemini.local', `CHAT_GEMINI_TOKEN=${gemini}\n`, { mode: 0o600 });
// Only hashes are printed. Raw tokens stay in the ignored env files.
const hash = (token) => createHash('sha256').update(token).digest('hex');
console.log('Register these hashes in the Supabase SQL editor:\n');
console.log(`insert into chat_private.credentials(token_hash, sender) values
  ('${hash(user)}', 'yeebyor'),
  ('${hash(claude)}', 'Claude'),
  ('${hash(gpt)}', 'GPT'),
  ('${hash(gemini)}', 'Gemini');`);
