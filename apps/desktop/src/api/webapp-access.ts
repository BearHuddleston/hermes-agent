import { hermesApi, profileScoped } from './client'

// Web access: make the browser-hosted web app on THIS machine reachable from
// other devices, behind the dashboard login. The backend owns every fact here;
// the pane only renders /status and asks for changes.

export type WebAccessMode = 'lan' | 'public'

export interface WebAccessServer {
  host: string
  /** False while the process prepares its runtime/renderer and the port is not open yet. */
  listening: boolean
  mode: 'lan' | 'local' | 'public'
  pid: number
  port: number
}

export interface WebAccessStatus {
  default_port: number
  lan_address: null | string
  nous_client_id: string
  password_username: string
  public_url: string
  running: WebAccessServer[]
}

export interface WebAccessPlan {
  mode: WebAccessMode
  port: number
  public_url?: string
}

export interface WebAccessStartResponse {
  mode: WebAccessMode
  name: string
  ok: boolean
  pid: number
  url: string
}

export function getWebAccessStatus(): Promise<WebAccessStatus> {
  return hermesApi<WebAccessStatus>({ ...profileScoped(), path: '/api/webapp-access/status' })
}

export function setWebAccessPassword(username: string, password: string): Promise<WebAccessStatus> {
  return hermesApi<WebAccessStatus>({
    ...profileScoped(),
    body: { password, username },
    method: 'POST',
    path: '/api/webapp-access/password'
  })
}

export function removeWebAccessPassword(): Promise<WebAccessStatus> {
  return hermesApi<WebAccessStatus>({ ...profileScoped(), method: 'DELETE', path: '/api/webapp-access/password' })
}

export function setUpWebAccessNous(plan: WebAccessPlan): Promise<WebAccessStatus> {
  return hermesApi<WebAccessStatus>({
    ...profileScoped(),
    body: plan,
    method: 'POST',
    path: '/api/webapp-access/nous'
  })
}

export function removeWebAccessNous(): Promise<WebAccessStatus> {
  return hermesApi<WebAccessStatus>({ ...profileScoped(), method: 'DELETE', path: '/api/webapp-access/nous' })
}

export function startWebAccess(plan: WebAccessPlan): Promise<WebAccessStartResponse> {
  return hermesApi<WebAccessStartResponse>({
    ...profileScoped(),
    body: plan,
    method: 'POST',
    path: '/api/webapp-access/start'
  })
}

export function stopWebAccess(): Promise<{ name: string; ok: boolean; pid: number }> {
  return hermesApi({ ...profileScoped(), method: 'POST', path: '/api/webapp-access/stop' })
}
