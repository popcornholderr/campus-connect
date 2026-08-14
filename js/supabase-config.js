/* ============================================================================
   supabase-config.js
   ----------------------------------------------------------------------------
   Get these from: Supabase dashboard → your project → Project Settings → API.
     - url      = "Project URL"
     - anonKey  = "anon" "public" key (NOT the service_role key — that one
                  must never be shipped to a browser)
   Safe to be public/committed — the anon key is designed to be client-side.
   Actual access control lives in Postgres Row Level Security policies,
   see supabase/schema.sql.
   ========================================================================== */

window.SUPABASE_CONFIG = {
  url: "https://uytjaincxtoccsewkjqc.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5dGphaW5jeHRvY2NzZXdranFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0MzIwNzUsImV4cCI6MjEwMjAwODA3NX0.2VnRirz4VnnNthZFnfieuBrOPu-m06cHc37e_QrS_AAE",
};
