This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Production Deploy Checklist (Vercel + Supabase)

### 1) Environment Variables (Vercel)
Set these in Vercel Project Settings → Environment Variables:

```
DATABASE_URL=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPER_ADMIN_EMAIL=
```

### 2) Supabase Auth Redirects
Supabase Dashboard → Authentication → URL Configuration:
- Site URL: `https://<your-app>.vercel.app`
- Redirect URLs: `https://<your-app>.vercel.app/*`

### 3) Build Command (Vercel)
Vercel Project Settings → Build & Development Settings:

```
npx prisma migrate deploy && npx prisma generate && next build
```

### 4) Direct DB URL
Use Supabase **Direct connection** URL for `DATABASE_URL` (with `sslmode=require`).

### 5) First Login
Sign up with the email you set in `SUPER_ADMIN_EMAIL` to become the initial super admin.

## New App Prisma (separate schema)

Use these commands for the new app schema only (`prisma/schema.new-app.prisma`):

```bash
# 1) Generate client for the new app
npm run prisma:new:generate

# 2) Create/apply local migration (development)
npm run prisma:new:migrate:dev -- --name init_new_app

# 3) Deploy migrations (production/CI)
npm run prisma:new:migrate:deploy

# Optional: inspect tables with Prisma Studio
npm run prisma:new:studio
```

If your database is already in use, create migration in a safe environment first and review SQL before deploy.
