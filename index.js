import { normalizeConfig, resolveDbPath } from './lib/config.js'
import { openStore } from './lib/store.js'
import { buildTools } from './lib/tools.js'
import { SYSTEM_SECTION } from './lib/prompts.js'

export const name = 'dsh-self-taught'

/**
 * Cordis 插件入口。所有服务都用可选链访问：缺哪个就不注册对应的能力，
 * 不要因为一个可选服务缺失导致整个 profile 起不来。
 */
export function apply(ctx, input) {
  const cfg = normalizeConfig(input)
  if (cfg.mode === 'off') return

  const log = (level, msg, extra) => {
    const fn = ctx?.logger?.[level]
    if (typeof fn === 'function') fn.call(ctx.logger, `[dsh-self-taught] ${msg}`, extra ?? '')
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

  const search =
    typeof ctx?.web?.search === 'function'
      ? (request, signal) => ctx.web.search(request, signal)
      : undefined
  if (!search) log('info', '没有 web.search，采样会退化为「缺乏共识」')

  if (ctx?.tools?.register) {
    for (const definition of buildTools({ store, search, cfg })) {
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
