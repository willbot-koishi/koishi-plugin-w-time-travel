import { Context, h, Schema, Session, SessionError } from 'koishi'
import parseDuration from 'parse-duration'
import { useGlobalCtxHook } from 'ctx-hook'

export const name = 'w-time-travel'

export const inject = {
  optional: [ 'database' ]
}

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

const fail = (message: string) => {
  throw new SessionError('w-time-travel.error', [ message ])
}

const enum TimeTravelMode {
  Relative,
  Absolute,
}

interface TimeTravelConfig {
  mode: TimeTravelMode
  param: number
}

interface TimeTravelWarp extends TimeTravelConfig {
  id: string
}

declare module 'koishi' {
  interface Tables {
    'w-time-travel-warp': TimeTravelWarp
  }
}

const parseTimeTravelMode = (mode: string): TimeTravelMode => {
  switch (mode.toLowerCase()) {
    case 'to':
      return TimeTravelMode.Absolute
    case 'by':
      return TimeTravelMode.Relative
    default:
      fail(`Invalid time travel mode, expected 'to' or 'by'.`)
  }
}

const stringifyTimeTravelConfig = (config: TimeTravelConfig): string => {
  switch (config.mode) {
    case TimeTravelMode.Absolute:
      return `to ${new Date(config.param).toLocaleString()}`
    case TimeTravelMode.Relative:
      return `by ${config.param}ms`
  }
}

const parseTimeTravelConfig = <M extends TimeTravelMode>(
  mode: M, param: string
): TimeTravelConfig & { mode: M } => {
  switch (mode) {
    case TimeTravelMode.Absolute: {
      const target = new Date(param).getTime()
      if (isNaN(target)) throw fail('Invalid target date.')
      return { mode: TimeTravelMode.Absolute as M, param: target }
    }
    case TimeTravelMode.Relative: {
      const delta = parseDuration(param)
      if (delta === null) throw fail('Invalid time delta.')
      return { mode: TimeTravelMode.Relative as M, param: delta }
    }
  }
}

export function apply(ctx: Context) {
  ctx.i18n.define('en-US', {
    'w-time-travel': {
      error: '{0}'
    }
  })

  const { wrap, dispose, als } = useGlobalCtxHook('Date', (Date0, config: TimeTravelConfig) => {
    const getTravelledNow = config.mode === TimeTravelMode.Absolute
      ? () => config.param
      : () => Date0.now() + config.param
    const getTravelledDate = () => new Date0(getTravelledNow())
    return new Proxy(Date0, {
      construct(_target, args) {
        if (! args.length) return getTravelledDate()
        return new Date0(...args as [])
      },
      apply(_target, _thisArg, _args) {
        return getTravelledDate().toString()
      },
      get(_target, prop) {
        if (prop === 'now') {
          return getTravelledNow
        }
        return Date0[prop]
      }
    })
  })

  ctx.on('dispose', dispose)

  ctx.command('time.travel', 'Time travel')

  ctx.command(
    'time.travel.to <date:string> <command:text>',
    h.escape('Time travel to <date> and execute <command>'),
    { authority: 3, strictOptions: true }
  )
    .action(async ({ session }, date, command) => travel(
      parseTimeTravelConfig(TimeTravelMode.Absolute, date),
      session,
      command,
    ))

  ctx.command(
    'time.travel.by <delta:string> <command:text>',
    h.escape('Time travel by <delta> and execute <command>'),
    { authority: 3, strictOptions: true }
  )
    .action(async ({ session }, delta, command) => travel(
      parseTimeTravelConfig(TimeTravelMode.Relative, delta),
      session,
      command
    ))

  const travel = (config: TimeTravelConfig, session: Session, command: string) => {
    console.log(Error().stack)

    if (config.mode === TimeTravelMode.Relative) {
      const parentConfig = als.getStore()
      if (parentConfig?.mode === TimeTravelMode.Relative)
        fail('Cannot nest relative time travels.')
      if (parentConfig?.mode === TimeTravelMode.Absolute) {
        config = {
          mode: TimeTravelMode.Absolute,
          param: parentConfig.param + config.param,
        }
      }
    }

    return wrap(() => session.execute(command), config)()
  }

  ctx.inject([ 'database' ], ctx => {
    ctx.model.extend('w-time-travel-warp', {
      id: 'string',
      mode: 'unsigned',
      param: 'integer',
    })

    ctx.command(
      'time.travel.warp <id:string> <command:text>',
      h.escape('Time travel using warp point <id> and execute <command>'),
      { strictOptions: true }
    )
      .action(async ({ session }, id, command) => {
        const [ warp ] = await ctx.database.get('w-time-travel-warp', id)
        if (! warp) fail(`Warp point '${id}' does not exist.`)

        return travel(warp, session, command)
      })

    ctx.command(
      'time.travel.warp.create <id:string> <mode:string> <param:string>',
      'Create a public time travel warp point',
      { authority: 3, strictOptions: true }
    )
      .action(async ({}, id, mode, param) => {
        const [ warp ] = await ctx.database.get('w-time-travel-warp', id)
        if (warp) fail(`Warp point '${id}' already exists.`)

        const config = parseTimeTravelConfig(parseTimeTravelMode(mode), param)
        await ctx.database.create('w-time-travel-warp', {
          id,
          ...config
        })
        return `Warp point '${id}' created.`
      })

    ctx.command(
      'time.travel.warp.delete <id:string>',
      'Delete a time travel warp point',
      { authority: 3 }
    )
      .action(async ({}, id) => {
        const [ warp ] = await ctx.database.get('w-time-travel-warp', id)
        if (! warp) fail(`Warp point '${id}' does not exist.`)

        await ctx.database.remove('w-time-travel-warp', id)
        return `Warp point '${id}' deleted.`
      })

    ctx.command('time.travel.warp.list', 'List all time travel warp points')
      .action(async () => {
        const warps = await ctx.database.get('w-time-travel-warp', {})
        if (! warps.length) return 'No warp points available.'
        return `${warps.length} warp point(s) available:\n` + warps
          .map(warp => `${warp.id}: ${stringifyTimeTravelConfig(warp)}`)
          .join('\n')
      })
  })
}
