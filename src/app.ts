import type { IncomingMessage, ServerResponse } from 'src/types/node'
import { withoutTrailingSlash } from '@nuxt/ufo'
import { lazyHandle, promisifyHandle } from './handle'
import type { Handle, LazyHandle, Middleware, PHandle } from './handle'
import { createError, sendError } from './error'
import { send, MIMES } from './utils'

export interface Layer {
  route: string
  match?: Matcher
  handle: Handle
}

export type Stack = Layer[]

export interface InputLayer {
  route?: string
  match?: Matcher
  handle: Handle | LazyHandle
  lazy?: boolean
  promisify?: boolean
}

export type InputStack = InputLayer[]

export type Matcher = (url: string, req?: IncomingMessage) => boolean

export interface AppUse {
  (route: string | string[], handle: Middleware | Middleware[], options?: Partial<InputLayer & { promisify: true }>): App
  (route: string | string[], handle: Handle | Handle[], options?: Partial<InputLayer>): App
  (handle: Middleware | Middleware[], options?: Partial<InputLayer & { promisify: true }>): App
  (handle: Handle | Handle[], options?: Partial<InputLayer>): App
  (options: InputLayer): App
}

export interface App {
  (req: IncomingMessage, res: ServerResponse): Promise<any>
  stack: Stack
  _handle: PHandle
  use: AppUse
  useAsync: AppUse
}

export interface AppOptions {
  debug?: boolean
  onError?: (error: Error, req: IncomingMessage, res: ServerResponse) => any
}

export function createApp (options: AppOptions = {}): App {
  const stack: Stack = []

  const _handle = createHandle(stack)

  // @ts-ignore
  const app: Partial<App> = function (req: IncomingMessage, res: ServerResponse) {
    return _handle(req, res).catch((error: Error) => {
      if (options.onError) {
        return options.onError(error, req, res)
      }
      // @ts-ignore
      if (typeof error.internal === 'undefined') {
        // @ts-ignore
        error.internal = true
      }
      return sendError(res, error, !!options.debug)
    })
  }

  app.stack = stack
  app._handle = _handle

  // @ts-ignore
  app.use = (arg1, arg2, arg3) => use(app, arg1, arg2, arg3)
  // @ts-ignore
  app.useAsync = (arg1, arg2) =>
    use(app as App, arg1, arg2 !== undefined ? arg2 : { promisify: false }, { promisify: false })

  return app as App
}

export function use (
  app: App,
  arg1: string | Handle | InputLayer | InputLayer[],
  arg2?: Handle | Partial<InputLayer> | Handle[],
  arg3?: Partial<InputLayer>
) {
  if (Array.isArray(arg1)) {
    arg1.forEach(i => use(app, i, arg2, arg3))
  } else if (Array.isArray(arg2)) {
    arg2.forEach(i => use(app, arg1, i, arg3))
  } else if (typeof arg1 === 'string') {
    app.stack.push(normalizeLayer({ ...arg3, route: arg1, handle: arg2 as Handle }))
  } else if (typeof arg1 === 'function') {
    app.stack.push(normalizeLayer({ ...arg2, route: '/', handle: arg1 as Handle }))
  } else {
    app.stack.push(normalizeLayer({ ...arg1 }))
  }
  return app
}

export function createHandle (stack: Stack): PHandle {
  return async function handle (req: IncomingMessage, res: ServerResponse) {
    // @ts-ignore express/connect compatibility
    req.originalUrl = req.originalUrl || req.url || '/'
    const reqUrl = req.url || '/'
    for (const layer of stack) {
      if (layer.route.length) {
        if (!reqUrl.startsWith(layer.route)) {
          continue
        }
        req.url = reqUrl.substr(layer.route.length) || '/'
      }
      if (layer.match && !layer.match(req.url as string, req)) {
        continue
      }
      const val = await layer.handle(req, res)
      if (res.writableEnded) {
        break
      }
      const type = typeof val
      if (type === 'string') {
        send(res, val, MIMES.html)
        break
      } else if (type === 'object' && val !== undefined) {
        if (val.buffer) {
          send(res, val)
        } else {
          send(res, JSON.stringify(val, null, 2), MIMES.json)
        }
        break
      }
    }
    if (!res.writableEnded) {
      return sendError(res, createError({ statusCode: 404, statusMessage: 'Not Found' }), false)
    }
  }
}

function normalizeLayer (layer: InputLayer) {
  return {
    route: withoutTrailingSlash(layer.route).toLocaleLowerCase(),
    match: layer.match,
    handle: layer.lazy
      ? lazyHandle(layer.handle as LazyHandle, layer.promisify)
      : (layer.promisify !== false ? promisifyHandle(layer.handle) : layer.handle)
  }
}
