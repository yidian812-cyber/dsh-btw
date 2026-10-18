#!/usr/bin/env node
/**
 * 客户端半侧冒烟测试（不渲染 React，不连浏览器）。
 *
 * 只验证三件在 CI 里能稳定复现的事：
 *  1. 模块以 `window.__ModuleLoader__.load` 的形态注册，且 id 与包名一致；
 *  2. inject 声明的服务齐全，apply 能装配成功（locale 字典 zh/en 键一致）；
 *  3. 两个 slot 注册确实发出（工具栏按钮 + 停靠面板）。
 */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const code = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

const sandbox = {
  window: { innerWidth: 1440, localStorage: { getItem: () => null, setItem: () => {} } },
  console,
  setTimeout,
  clearTimeout,
}
vm.createContext(sandbox)

let captured
sandbox.window.__ModuleLoader__ = {
  load(mod) {
    captured = mod
  },
}
vm.runInContext(code, sandbox)

function check(condition, message) {
  if (!condition) throw new Error(message)
}

check(captured !== undefined, '__ModuleLoader__.load was not called')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
check(captured.id === pkg.name, `module id "${captured.id}" does not match package name "${pkg.name}"`)

const React = {
  createElement: () => ({ type: 'element' }),
  Fragment: 'Fragment',
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  useSyncExternalStore: () => ({}),
}
const mod = captured.factory((name) => {
  check(name === 'react', `unexpected require("${name}")`)
  return React
})

check(Array.isArray(mod.inject), 'inject must be an array')
check(mod.inject.includes('slots'), 'inject must include "slots"')

let registered
const slots = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') dispose()
  },
  locale: {
    register(ns, dicts) {
      registered = { ns, dicts }
      return () => {}
    },
    bind(ns) {
      return (key) => {
        const dict = registered && registered.ns === ns ? registered.dicts.zh : {}
        return dict[key] ?? key
      }
    },
  },
  slots: {
    inject(name, callback) {
      callback()
    },
    register(options) {
      slots.push(options)
      return () => {}
    },
  },
}
mod.apply(ctx)

check(registered !== undefined, 'locale dictionary was not registered')
const zhKeys = Object.keys(registered.dicts.zh)
const enKeys = new Set(Object.keys(registered.dicts.en))
const missing = zhKeys.filter((key) => !enKeys.has(key))
check(missing.length === 0, `en dictionary is missing: ${missing.join(', ')}`)

const ids = slots.map((entry) => `${entry.name}/${entry.id}`)
check(ids.includes('conversation.input.right/dsh-btw-toggle'), 'toggle slot registration missing')
check(ids.includes('shell.overlay/dsh-btw-panel'), 'panel slot registration missing')

console.log(`client module OK: ${captured.id}, ${zhKeys.length} locale keys, ${ids.length} slot registrations`)
