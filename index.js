import { normalizeConfig, resolveDbPath } from './lib/config.js'
import { openStore } from './lib/store.js'
import { buildTools } from './lib/tools.js'
import { SYSTEM_SECTION } from './lib/prompts.js'

export const name = 'dsh-self-taught'

/**
 * Cordis 服务依赖声明（数组形式，本版本只认数组；对象形式会被当成两个叫 required/optional 的服务）。
 * 只声明真正必需的：没有它们插件没有意义。web / logger 用 ctx.reflect.get 读，
 * 不写进 inject —— 否则缺一个就会让这个条目永远 pending。
 */
export const inject = ['systemPrompt', 'tools']

/** 不声明 inject 也能安全读服务：拿不到就是 undefined，不抛。 */
function readService(ctx, name) {
  try {
    if (typeof ctx?.reflect?.get === 'function') return ctx.reflect.get(name)
  } catch {
    /* ignore */
  }
  return undefined
}

/**
 * Cordis 插件入口。所有服务都用可选链访问：缺哪个就不注册对应的能力，
 * 不要因为一个可选服务缺失导致整个 profile 起不来。
 */
export function apply(ctx, input) {
  const cfg = normalizeConfig(input)
  if (cfg.mode === 'off') return

  const logger = readService(ctx, 'logger')
  const log = (level, msg, extra) => {
    const fn = logger?.[level]
    if (typeof fn === 'function') fn.call(logger, `[dsh-self-taught] ${msg}`, extra ?? '')
  }

  const dbPath = resolveDbPath(cfg)
  let store
  try {
    store = openStore(dbPath)
  } catch (error) {
    log('warn', `打不开偏好库 ${dbPath}，插件降级为不记录`, error)
    return
  }

  const disposers = []
  const keep = (maybeDisposer) => {
    if (typeof maybeDisposer === 'function') disposers.push(maybeDisposer)
  }

  if (ctx?.systemPrompt?.section) {
    keep(
      ctx.systemPrompt.section({
        name: 'dsh-self-taught',
        order: 40,
        text: SYSTEM_SECTION,
      }),
    )
  } else {
    log('warn', '没有 systemPrompt 服务，主观问题流程不会生效')
  }

  // web 不写进 inject：这里惰性读取，缺了就让采样退化为「缺乏共识」，而不是让整个条目 pending
  const search = async (request, signal) => {
    const web = readService(ctx, 'web')
    if (typeof web?.search !== 'function') throw new Error('web.search 不可用')
    return web.search(request, signal)
  }
  // 搜索结果不带日期，靠 fetch 自己补：抓不到日期时判级会落到 weak，不影响可用性
  const fetchOne = async (request, signal) => {
    const web = readService(ctx, 'web')
    if (typeof web?.fetch !== 'function') throw new Error('web.fetch 不可用')
    return web.fetch(request, signal)
  }
  const hasFetch = (() => {
    try {
      return typeof readService(ctx, 'web')?.fetch === 'function'
    } catch {
      return false
    }
  })()
  if (!hasFetch) log('info', '没有 web.fetch，采样结果不补发布日期（strong 档不可达）')
  const hasSearch = (() => {
    try {
      return typeof readService(ctx, 'web')?.search === 'function'
    } catch {
      return false
    }
  })()
  if (!hasSearch) log('info', '没有 web.search，采样会退化为「缺乏共识」')

  if (ctx?.tools?.register) {
    for (const definition of buildTools({
      store,
      search: hasSearch ? search : undefined,
      fetch: hasFetch ? fetchOne : undefined,
      cfg,
    })) {
      try {
        keep(ctx.tools.register(definition))
      } catch (error) {
        log('warn', `注册工具 ${definition.name} 失败`, error)
      }
    }
  } else {
    log('warn', '没有 tools 服务，三个工具都不会出现')
  }

  const dispose = () => {
    for (const d of disposers.reverse()) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    store.close()
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => dispose)
  } else if (typeof ctx?.on === 'function') {
    ctx.on('dispose', dispose)
  }
}
