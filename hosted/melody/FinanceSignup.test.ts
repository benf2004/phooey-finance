import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import app from 'index'
import { migrate, mock, mockedKV } from 'tests/mock'
import { getApp, postAuthorizeBody } from 'tests/identity'
import { adapterConfig, routeConfig } from 'configs'

const signingKeys = generateKeyPairSync('rsa', {modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}})
let db: Database
let originalEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  db = await migrate()
  originalEnv = { ...process.env }
  const get = mockedKV.get.bind(mockedKV)
  vi.spyOn(mockedKV, 'get').mockImplementation(async (key:string) => {
    if (key === adapterConfig.BaseKVKey.JwtPrivateSecret) return signingKeys.privateKey
    if (key === adapterConfig.BaseKVKey.JwtPublicSecret) return signingKeys.publicKey
    return get(key)
  })
  process.env.ENABLE_EMAIL_VERIFICATION = true as unknown as string
  process.env.ENABLE_USER_APP_CONSENT = false as unknown as string
  process.env.ENFORCE_ONE_MFA_ENROLLMENT = [] as unknown as string
  process.env.ALLOW_PASSKEY_ENROLLMENT = false as unknown as string
  process.env.EMAIL_MFA_IS_REQUIRED = false as unknown as string
  process.env.OTP_MFA_IS_REQUIRED = false as unknown as string
  process.env.SMS_MFA_IS_REQUIRED = false as unknown as string
  process.env.SERVER_SESSION_EXPIRES_IN = 0 as unknown as string
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})
afterEach(async () => { db.close(); await mockedKV.empty(); Object.assign(process.env, originalEnv); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const post = (path:string, body:object) => app.request(path, {method:'POST',body:JSON.stringify(body)},mock(db))

describe('Finance email signup', () => {
  it('requires email confirmation, accepts retries, and does not require 2FA on later sign-ins', async () => {
    const client = await getApp(db)
    const credentials = {...await postAuthorizeBody(client),email:'new@example.test',password:'Password1!'}
    const created = await post(routeConfig.IdentityRoute.AuthorizeAccount, credentials)
    expect(created.status).toBe(200)
    const pending = await created.json() as {code:string;nextPage:string}
    expect(pending.nextPage).toBe(routeConfig.View.EmailMfa)
    expect(global.fetch).not.toHaveBeenCalled()
    const send = await post(routeConfig.IdentityRoute.SendEmailMfa,{code:pending.code,locale:'en'})
    expect(send.status).toBe(200)
    const key = `${adapterConfig.BaseKVKey.EmailMfaCode}-${pending.code}`
    const code = await mockedKV.get(key)
    expect(code).toMatch(/^\d{6}$/)
    const badCode = code === '000000' ? '000001' : '000000'
    const bad = await post(routeConfig.IdentityRoute.ProcessEmailMfa,{code:pending.code,mfaCode:badCode,locale:'en'})
    expect(bad.ok).toBe(false)
    expect(db.prepare('SELECT "emailVerified" FROM "user" WHERE email=?').get(credentials.email)).toMatchObject({emailVerified:0})
    const confirmed = await post(routeConfig.IdentityRoute.ProcessEmailMfa,{code:pending.code,mfaCode:code,locale:'en'})
    expect(confirmed.status).toBe(200)
    expect((await confirmed.json() as {nextPage?:string}).nextPage).toBeUndefined()
    expect(db.prepare('SELECT "emailVerified" FROM "user" WHERE email=?').get(credentials.email)).toMatchObject({emailVerified:1})
    const token = await app.request(routeConfig.OauthRoute.Token, {
      method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({grant_type:'authorization_code',code:pending.code,code_verifier:'abc',client_id:client.clientId,redirect_uri:credentials.redirectUri}).toString(),
    }, mock(db))
    expect(token.status).toBe(200)
    const tokens = await token.json() as {access_token:string}
    expect(tokens.access_token).toBeTruthy()
    const profile = await app.request(routeConfig.OauthRoute.Userinfo, {headers:{Authorization:'Bearer '+tokens.access_token}},mock(db))
    expect(profile.status).toBe(200)
    expect(await profile.json()).toMatchObject({email:credentials.email,emailVerified:true})
    const again = await post(routeConfig.IdentityRoute.AuthorizePassword,credentials)
    expect(again.status).toBe(200)
    expect((await again.json() as {nextPage?:string}).nextPage).toBeUndefined()
  })
  it('does not exchange an unverified signup code for an access token', async () => {
    const client = await getApp(db)
    const credentials = {...await postAuthorizeBody(client),email:'blocked@example.test',password:'Password1!'}
    const created = await post(routeConfig.IdentityRoute.AuthorizeAccount,credentials)
    const pending = await created.json() as {code:string}
    const token = await app.request(routeConfig.OauthRoute.Token, {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'authorization_code',code:pending.code,code_verifier:'abc',client_id:client.clientId,redirect_uri:credentials.redirectUri}).toString(),
    },mock(db))
    expect(token.ok).toBe(false)
  })
  it('resumes verification when an unverified user signs in again', async () => {
    const client = await getApp(db)
    const credentials = {...await postAuthorizeBody(client),email:'retry@example.test',password:'Password1!'}
    expect((await post(routeConfig.IdentityRoute.AuthorizeAccount,credentials)).ok).toBe(true)
    const retry = await post(routeConfig.IdentityRoute.AuthorizePassword,credentials)
    expect(retry.status).toBe(200)
    expect((await retry.json() as {nextPage:string}).nextPage).toBe(routeConfig.View.EmailMfa)
  })
})
