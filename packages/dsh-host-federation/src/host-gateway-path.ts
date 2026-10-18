/**
 * Path and HTML rules for the same-origin host gateway.
 *
 * The browser keeps calling ordinary DSH URLs. This module only decides which
 * registered host a `/threadharbor/gateway/<hostId>/...` path names, and how
 * the returned page is rewritten so those calls stay on this prefix.
 * No network here.
 */

import { isValidHostId } from './identity.ts'
import { normalizeAddress } from './registry.ts'

/** HTTP prefix. Must not end with `/`: the host matches `prefix + '/'`. */
export const GATEWAY_PREFIX = '/threadharbor/gateway'

/**
 * Single WebSocket upgrade path.
 *
 * The host upgrade table is one exact path per registration, so every remote
 * mux is folded onto this path (`?host=&path=`) by the injected page script.
 */
export const GATEWAY_WS_PATH = '/threadharbor/gateway-ws'

const REWRITE_LIMIT_BYTES = 32 * 1024 * 1024

export type GatewayRoute =
  | { readonly ok: true; readonly hostId: string; readonly upstreamPath: string; readonly search: string }
  | { readonly ok: false; readonly status: 400 | 404; readonly message: string }

export type LaunchTarget =
  | { readonly ok: true; readonly origin: string; readonly token: string }
  | { readonly ok: false; readonly status: 404; readonly message: string }

/** Page URL the iframe loads for one registered host. */
export function gatewayPagePath(hostId: string): string {
  return `${GATEWAY_PREFIX}/${encodeURIComponent(hostId)}/`
}

/**
 * Split a gateway HTTP path into a host id and the path to request upstream.
 * `..` is rejected after URL normalization, and the id must be one segment.
 */
export function parseGatewayRequest(rawUrl: string): GatewayRoute {
  let url: URL
  try {
    url = new URL(rawUrl, 'http://gateway.invalid')
  } catch {
    return { ok: false, status: 400, message: '地址无效' }
  }
  const path = safePath(url.pathname)
  if (path === undefined) return { ok: false, status: 400, message: '路径无法解码' }
  if (path !== GATEWAY_PREFIX && !path.startsWith(`${GATEWAY_PREFIX}/`)) {
    return { ok: false, status: 404, message: '要在路径里写主机标识' }
  }
  const rest = path.slice(GATEWAY_PREFIX.length + 1)
  if (rest === '') return { ok: false, status: 404, message: '要在路径里写主机标识' }
  const slash = rest.indexOf('/')
  const hostId = slash === -1 ? rest : rest.slice(0, slash)
  const tail = slash === -1 ? '' : rest.slice(slash)
  if (!usableHostId(hostId)) return { ok: false, status: 400, message: '主机标识不合法' }
  if (!usableUpstreamPath(tail === '' ? '/' : tail)) return { ok: false, status: 400, message: '路径不合法' }
  return { ok: true, hostId, upstreamPath: tail === '' ? '/' : tail, search: url.search }
}

/** Split the upgrade query (`host`, `path`) the injected script sends. */
export function parseGatewayUpgrade(rawUrl: string): GatewayRoute {
  let url: URL
  try {
    url = new URL(rawUrl, 'http://gateway.invalid')
  } catch {
    return { ok: false, status: 400, message: '地址无效' }
  }
  if (url.pathname !== GATEWAY_WS_PATH) return { ok: false, status: 404, message: '不是网关的升级路径' }
  const hostId = url.searchParams.get('host') ?? ''
  const rawPath = url.searchParams.get('path') ?? ''
  if (!usableHostId(hostId)) return { ok: false, status: 400, message: '主机标识不合法' }
  const query = rawPath.indexOf('?')
  const upstreamPath = query === -1 ? rawPath : rawPath.slice(0, query)
  const search = query === -1 ? '' : rawPath.slice(query)
  if (!usableUpstreamPath(upstreamPath)) return { ok: false, status: 400, message: '路径不合法' }
  return { ok: true, hostId, upstreamPath, search }
}

/**
 * The launch URL stored for this host, or why it cannot be used.
 * The browser never supplies the URL: only the registry document does, and the
 * origin must match the registered address.
 */
export function resolveLaunch(registryJson: string | undefined, hostId: string): LaunchTarget {
  if (registryJson === undefined || registryJson.trim() === '') {
    return { ok: false, status: 404, message: '还没有登记任何主机' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(registryJson)
  } catch {
    return { ok: false, status: 404, message: '主机登记读不出来' }
  }
  if (!Array.isArray(parsed)) return { ok: false, status: 404, message: '主机登记读不出来' }
  const entry = parsed.find(item => isRecord(item) && item['hostId'] === hostId)
  if (!isRecord(entry)) return { ok: false, status: 404, message: '没有这台已登记的主机' }
  if (typeof entry['launchUrl'] !== 'string' || entry['launchUrl'].trim() === '') {
    return { ok: false, status: 404, message: '这台主机还没有打开地址' }
  }
  let launch: URL
  try {
    launch = new URL(entry['launchUrl'])
  } catch {
    return { ok: false, status: 404, message: '这台主机的打开地址无效' }
  }
  if (launch.protocol !== 'http:' && launch.protocol !== 'https:') {
    return { ok: false, status: 404, message: '这台主机的打开地址无效' }
  }
  if (typeof entry['address'] === 'string') {
    const address = normalizeAddress(entry['address'])
    if (!address.ok || address.origin !== launch.origin) {
      return { ok: false, status: 404, message: '登记的打开地址和主机地址对不上' }
    }
  }
  const token = launch.searchParams.get('token')
  if (token === null || token === '') return { ok: false, status: 404, message: '打开地址里没有登录令牌' }
  return { ok: true, origin: launch.origin, token }
}

/** True when the registered origin is the page the browser is already on. */
export function pointsAtPageHost(origin: string, pageHost: string | undefined): boolean {
  if (pageHost === undefined || pageHost.trim() === '') return false
  let remote: URL
  let local: URL
  try {
    remote = new URL(origin)
    local = new URL(`http://${pageHost}`)
  } catch {
    return false
  }
  return remote.host === local.host
}

/** Keep a redirect inside the gateway when it points at the remote origin. */
export function rewriteLocation(location: string, origin: string, hostId: string): string {
  const prefix = gatewayPagePath(hostId).replace(/\/$/, '')
  if (location.startsWith('/') && !location.startsWith('//')) return prefix + location
  try {
    const url = new URL(location, origin)
    if (url.origin === new URL(origin).origin) return prefix + url.pathname + url.search + url.hash
  } catch {
    return location
  }
  return location
}

export type RewriteKind = 'html' | 'css' | 'js'

/** Which text responses need their root-absolute URLs pointed at the gateway. */
export function rewriteKind(contentType: string | undefined): RewriteKind | undefined {
  const type = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type === 'text/css') return 'css'
  if (
    type === 'text/javascript'
    || type === 'application/javascript'
    || type === 'application/x-javascript'
    || type === 'text/ecmascript'
    || type === 'application/ecmascript'
  ) return 'js'
  return undefined
}

export const GATEWAY_REWRITE_LIMIT_BYTES = REWRITE_LIMIT_BYTES

/** Rewrite one text body. Callers skip this when the body is over the limit. */
export function rewriteBody(kind: RewriteKind, body: string, hostId: string): string {
  if (kind === 'html') return rewriteHtml(body, hostId)
  if (kind === 'css') return rewriteCss(body, hostId)
  return rewriteJs(body, hostId)
}

/**
 * First thing in `<head>`: base URL, then a script that sends root-absolute
 * fetches and the mux socket through this gateway, and keeps the framed app's
 * storage off the parent page's keys.
 */
export function rewriteHtml(html: string, hostId: string): string {
  const root = gatewayPagePath(hostId)
  const rewritten = html.replace(
    /(\s(?:src|href|action|poster)\s*=\s*)(['"])\/(?!\/)/gi,
    (_match, lead: string, quote: string) => `${lead}${quote}${root}`,
  )
  const inject = `<base href="${root}"><script>${gatewayClientScript(hostId)}</script>`
  if (/<head\b[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<head\b[^>]*>/i, match => `${match}${inject}`)
  }
  if (/<html\b[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<html\b[^>]*>/i, match => `${match}<head>${inject}</head>`)
  }
  return `<!DOCTYPE html><head>${inject}</head>${rewritten}`
}

export function rewriteCss(css: string, hostId: string): string {
  const root = gatewayPagePath(hostId)
  return css.replace(/url\(\s*(['"]?)\/(?!\/)/gi, (_match, quote: string) => `url(${quote}${root}`)
}

export function rewriteJs(js: string, hostId: string): string {
  const root = gatewayPagePath(hostId)
  return js.replace(/(['"`])\/assets\//g, (_match, quote: string) => `${quote}${root}assets/`)
}

/**
 * Runs in the framed page before the remote app.
 * Root-absolute URLs are prefixed; the mux WebSocket is sent to {@link GATEWAY_WS_PATH}.
 * Storage, cookies, and service workers stay in this frame so they cannot overwrite the parent page.
 */
export function gatewayClientScript(hostId: string): string {
  const prefix = JSON.stringify(gatewayPagePath(hostId).replace(/\/$/, ''))
  const id = JSON.stringify(hostId)
  const wsPath = JSON.stringify(GATEWAY_WS_PATH)
  return `(function(){
var prefix=${prefix};
var hostId=${id};
var wsPath=${wsPath};
var mark="thgw:"+hostId+":";
var realLocal=null;
var realSession=null;
try{realLocal=window.localStorage;realSession=window.sessionStorage;}catch(e){}
function partitioned(real){
function names(){
var out=[];
for(var i=0;i<real.length;i++){
var raw=real.key(i);
if(raw!==null&&raw.indexOf(mark)===0)out.push(raw.slice(mark.length));
}
return out;
}
return {
getItem:function(name){return real.getItem(mark+String(name));},
setItem:function(name,value){real.setItem(mark+String(name),String(value));},
removeItem:function(name){real.removeItem(mark+String(name));},
clear:function(){names().forEach(function(name){real.removeItem(mark+name);});},
key:function(index){var list=names();return index>=0&&index<list.length?list[index]:null;},
get length(){return names().length;}
};
}
try{
if(realLocal&&realSession){
Object.defineProperty(window,"localStorage",{configurable:true,get:function(){return partitioned(realLocal);}});
Object.defineProperty(window,"sessionStorage",{configurable:true,get:function(){return partitioned(realSession);}});
}
}catch(e){}
try{
var cookieDesc=Object.getOwnPropertyDescriptor(Document.prototype,"cookie");
if(cookieDesc&&cookieDesc.configurable){
Object.defineProperty(Document.prototype,"cookie",{configurable:true,get:function(){return "";},set:function(){}});
}
}catch(e){}
try{
if(navigator.serviceWorker){
navigator.serviceWorker.register=function(){return Promise.reject(new Error("gateway frame does not register service workers"));};
}
}catch(e){}
var OrigBC=window.BroadcastChannel;
if(typeof OrigBC==="function"){
var WrappedBC=function(name){return new OrigBC(mark+String(name));};
WrappedBC.prototype=OrigBC.prototype;
window.BroadcastChannel=WrappedBC;
}
function toUrl(input){try{return new URL(String(input),document.baseURI);}catch(e){return null;}}
function underPrefix(url){return url.pathname===prefix||url.pathname.indexOf(prefix+"/")===0;}
function rewriteHttp(input){
var url=toUrl(input);
if(!url||url.origin!==location.origin||underPrefix(url)||url.pathname===wsPath)return input;
return prefix+url.pathname+url.search+url.hash;
}
var origFetch=window.fetch;
if(typeof origFetch==="function"){
window.fetch=function(input,init){
if(typeof input==="string"||input instanceof URL)return origFetch.call(this,rewriteHttp(String(input)),init);
return origFetch.call(this,input,init);
};
}
var origOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
var args=[method,typeof url==="string"?rewriteHttp(url):url];
for(var i=2;i<arguments.length;i++)args.push(arguments[i]);
return origOpen.apply(this,args);
};
var OrigWS=window.WebSocket;
function wsUrl(input){
var url=toUrl(input);
if(!url||url.origin!==location.origin)return String(input);
if(url.pathname===wsPath)return String(input);
var path=url.pathname;
if(underPrefix(url))path=path===prefix?"/":path.slice(prefix.length);
var query="host="+encodeURIComponent(hostId)+"&path="+encodeURIComponent(path+url.search);
var proto=location.protocol==="https:"?"wss:":"ws:";
return proto+"//"+location.host+wsPath+"?"+query;
}
class WrappedWS extends OrigWS{
constructor(url,protocols){
if(protocols===undefined)super(wsUrl(url));
else super(wsUrl(url),protocols);
}
}
window.WebSocket=WrappedWS;
})();`
}

function usableHostId(hostId: string): boolean {
  if (!isValidHostId(hostId) || hostId === '.' || hostId === '..') return false
  return !/[\u0000-\u001f?#]/.test(hostId)
}

function usableUpstreamPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('\0')) return false
  return !path.split('/').some(segment => segment === '.' || segment === '..')
}

function safePath(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
