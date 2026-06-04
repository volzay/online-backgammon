# Supabase Setup

1. Create a Supabase project.
2. Open SQL Editor.
3. Run `schema.sql`.
4. In Authentication, enable Email signups.
5. In Realtime settings, verify Realtime is enabled.
6. Project URL is `https://pzknykygxtbzdhuitzzh.supabase.co`.
7. Publishable browser key is configured in `.github/workflows/pages.yml`.
8. In Authentication -> URL Configuration, set:
   - Site URL: `https://volzay.github.io/online-backgammon`
   - Redirect URL: `https://volzay.github.io/online-backgammon/login.html`

If email confirmation is enabled, registration shows a confirmation message and the user signs in after following the email link. If email confirmation is disabled for MVP testing, sign-up returns an active session immediately.

The browser must only receive the public anon/publishable key. Never expose the `service_role` key in `runtime-config.js`, GitHub Actions, or frontend code.
