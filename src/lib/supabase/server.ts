import { authCookieOptions } from "@/lib/supabase/cookie-options";
import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/database.types';
import { supabaseConfig } from './config';
import { AppError } from '@/lib/errors';
export async function createClient(options: { readOnly?: boolean } = {}) {
 const config = supabaseConfig();
 if (!config) throw new AppError(503, 'configuration_required', 'Supabase の接続設定が必要です');
 const jar = await cookies();
 return createServerClient<Database>(config.url, config.key, {
  cookieOptions: authCookieOptions(),
  cookies: {
   getAll: () => jar.getAll(),
   setAll: (entries) => {
    if (options.readOnly) return;
    for (const { name, value, options } of entries) jar.set(name, value, options);
   },
  },
 });
}
