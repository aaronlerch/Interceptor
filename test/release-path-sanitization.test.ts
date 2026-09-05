import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const readScript = (name: string) =>
  readFileSync(resolve(root, "scripts", name), "utf8")

describe("release source-path sanitization", () => {
  test("maps SwiftPM dependency paths in the native bridge build", () => {
    const source = readScript("build-bridge.sh")

    expect(source).toContain(
      "-ffile-prefix-map=$BRIDGE_DIR/.build/checkouts=/src/interceptor-deps",
    )
    expect(source).toContain('swift build -c release "${SWIFT_FLAGS[@]}"')
    expect(source).toContain('/usr/bin/strip -x "$BINARY"')
  })

  // FORK-DELTA §1: the iOS runner build/staging is removed from this fork, so
  // upstream's two runner path-sanitization cases are gone with it. The macOS,
  // Safari and Windows cases below still guard the same property.

  test("maps C and Swift source paths in the Safari app build", () => {
    const source = readScript("build-safari.sh")

    expect(source).toContain('PUBLIC_SOURCE_ROOT="/src/interceptor"')
    expect(source).toContain(
      '\\"-ffile-prefix-map=$REPO_ROOT=$PUBLIC_SOURCE_ROOT\\"',
    )
    expect(source).toContain(
      '-file-prefix-map \\"$REPO_ROOT=$PUBLIC_SOURCE_ROOT\\"',
    )
    expect(source).toContain(
      '-file-compilation-dir \\"$PUBLIC_SOURCE_ROOT/safari/InterceptorSafari\\"',
    )
    expect(source).toContain(
      '/usr/bin/strip -x "$APP/Contents/PlugIns/InterceptorSafari Extension.appex/Contents/MacOS/InterceptorSafari Extension"',
    )
    expect(source).toContain(
      '/usr/bin/strip -x "$APP/Contents/MacOS/InterceptorSafari"',
    )
  })
})
