import { cache } from 'react';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

// React.cache shares one auth lookup between the dashboard layout and its page
// during a single server render. It never shares users or sessions across requests.
export const authClient = cache(async () => {
  const jar = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase не настроен');
  return createServerClient(url, key, {
    cookies: {
      getAll() { return jar.getAll(); },
      setAll(items: { name: string; value: string; options?: CookieOptions }[]) {
        try {
          items.forEach(({ name, value, options }) => jar.set(name, value, options));
        } catch {
          // Server Components cannot set cookies. Middleware handles refresh.
        }
      },
    },
  });
});

// IMPORTANT: Unlike a module-wide map, React.cache is request scoped.
// Continue to use getUser(), which validates the session with Supabase Auth.
export const teacher = cache(async () => {
  const sb = await authClient();
  const started = performance.now();
  const { data: { user }, error } = await sb.auth.getUser();
  if (process.env.QUIZFLOW_PROFILE === '1') {
    console.info(`[QuizFlow perf] Supabase getUser: ${Math.round(performance.now() - started)}ms`);
  }
  if (error || !user || !process.env.TEACHER_EMAIL ||
    user.email?.toLowerCase() !== process.env.TEACHER_EMAIL.toLowerCase()) return null;
  return user;
});

export async function requireTeacher() {
  const user = await teacher();
  if (!user) throw new Error('UNAUTHORIZED');
  return user;
}

export function adminDB() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase не настроен');
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
