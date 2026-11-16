import { createClient } from '@supabase/supabase-js'

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const appUrl = (
  (import.meta.env.VITE_APP_URL as string | undefined) || 'https://meu-driver.vercel.app'
).replace(/\/+$/, '')

export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null

export const storageBucket = (import.meta.env.VITE_SUPABASE_BUCKET as string | undefined) || 'MeuDriver'
