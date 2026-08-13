import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env['DATABASE_URL'] ??
      'postgres://serviceloop:serviceloop@localhost:5432/serviceloop',
  },
  strict: true,
  verbose: true,
});
