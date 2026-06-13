import { httpRequest } from './httpRequest.js'

const BASE = process.env.UDH_BASE_URL ?? 'https://social.8338.hk'
const KEY = process.env.UDH_API_KEY

if (!KEY) console.warn('[udhouse] UDH_API_KEY not set — UD House skill will fail')

async function call<T = any>(path: string): Promise<T> {
  return httpRequest<T>(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
  })
}

export interface UDHListing {
  id: string
  title?: string
  address?: string
  price?: number
  status?: string
  share_url?: string
  created_at?: string
  district?: string
}

export interface UDHLead {
  id: string
  listing_id?: string
  listing_title?: string
  name?: string
  contact?: string
  message?: string
  created_at?: string
}

export interface UDHWhoami {
  product: string
  tenant_id: string
  uid: string
  name?: string
}

export async function whoami(): Promise<UDHWhoami> {
  return call<UDHWhoami>('/api/v1/me')
}

export async function listListings(): Promise<UDHListing[]> {
  const r = await call<any>('/api/v1/listings')
  return r.data ?? r.listings ?? r
}

export async function listLeads(): Promise<UDHLead[]> {
  const r = await call<any>('/api/v1/leads')
  return r.data ?? r.leads ?? r
}

/**
 * Probe whether the currently configured UDH_API_KEY has admin access.
 * Reads env vars at call-time (not module-load) so tests can override UDH_BASE_URL.
 * Returns true on HTTP 200, false on 403 or any error (fail-safe non-admin).
 */
export async function probeAdminAccess(): Promise<boolean> {
  const base = process.env.UDH_BASE_URL ?? 'https://social.8338.hk'
  const key = process.env.UDH_API_KEY
  try {
    await httpRequest<any>(`${base}/api/v1/admin/stats`, {
      headers: {
        Authorization: `Bearer ${key ?? ''}`,
        'Content-Type': 'application/json',
      },
    })
    return true
  } catch {
    return false
  }
}
