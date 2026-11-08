import { describe, expect, it } from 'vitest'

import { resolveIsWayland, supportsGlobalCursorPosition } from './ozone'

describe('resolveIsWayland', () => {
  it('resolves to true when --ozone-platform is explicitly wayland', () => {
    expect(resolveIsWayland({
      explicitOzonePlatform: 'wayland',
      env: {},
    })).toBe(true)
  })

  it('resolves to false when --ozone-platform is explicitly x11 even in Wayland environment', () => {
    expect(resolveIsWayland({
      explicitOzonePlatform: 'x11',
      env: {
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_SESSION_TYPE: 'wayland',
      },
    })).toBe(false)
  })

  it('treats --ozone-platform=auto as unresolved and falls back to environment', () => {
    expect(resolveIsWayland({
      explicitOzonePlatform: 'auto',
      env: {
        WAYLAND_DISPLAY: 'wayland-0',
      },
    })).toBe(true)

    expect(resolveIsWayland({
      explicitOzonePlatform: 'auto',
      env: {
        XDG_SESSION_TYPE: 'x11',
      },
    })).toBe(false)
  })

  it('resolves based on --ozone-platform-hint when not auto', () => {
    expect(resolveIsWayland({
      ozonePlatformHint: 'wayland',
      env: {},
    })).toBe(true)

    expect(resolveIsWayland({
      ozonePlatformHint: 'x11',
      env: {
        WAYLAND_DISPLAY: 'wayland-0',
      },
    })).toBe(false)
  })

  it('treats --ozone-platform-hint=auto as unresolved and falls back to environment', () => {
    expect(resolveIsWayland({
      ozonePlatformHint: 'auto',
      env: {
        WAYLAND_DISPLAY: 'wayland-0',
      },
    })).toBe(true)

    expect(resolveIsWayland({
      ozonePlatformHint: 'auto',
      env: {},
    })).toBe(false)
  })

  it('falls back to environment variables when no flags are present', () => {
    expect(resolveIsWayland({
      env: {
        WAYLAND_DISPLAY: 'wayland-0',
      },
    })).toBe(true)

    expect(resolveIsWayland({
      env: {
        XDG_SESSION_TYPE: 'wayland',
      },
    })).toBe(true)

    expect(resolveIsWayland({
      env: {
        XDG_SESSION_TYPE: 'x11',
      },
    })).toBe(false)

    expect(resolveIsWayland({
      env: {},
    })).toBe(false)
  })
})

describe('global cursor support', () => {
  it.each([
    { WAYLAND_DISPLAY: 'wayland-0' },
    { XDG_SESSION_TYPE: 'wayland' },
  ])('keeps XWayland interactive when the desktop reports %o', (env) => {
    expect(supportsGlobalCursorPosition({ platform: 'linux', explicitOzonePlatform: 'x11', env })).toBe(false)
  })

  it('disables cursor-based click-through on native Wayland without session variables', () => {
    expect(supportsGlobalCursorPosition({ platform: 'linux', explicitOzonePlatform: 'wayland', env: {} })).toBe(false)
  })

  it('retains cursor-based click-through in a native X11 session', () => {
    expect(supportsGlobalCursorPosition({ platform: 'linux', explicitOzonePlatform: 'x11', env: { XDG_SESSION_TYPE: 'x11' } })).toBe(true)
  })

  it('does not let inherited Linux session variables disable Windows input forwarding', () => {
    expect(supportsGlobalCursorPosition({ platform: 'win32', env: { WAYLAND_DISPLAY: 'wayland-0' } })).toBe(true)
  })
})
