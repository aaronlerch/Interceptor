import { describe, expect, test } from "bun:test"
import { captureSubprocessSync as spawnSync } from "../shared/subprocess-sync"
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

  test("maps cargo, toolchain and checkout paths in the Windows and Linux native builds", () => {
    const linux = readScript("build-desktop-linux.sh")
    for (const to of ["/cargo", "/rust/toolchain", "/src/interceptor"]) {
      expect(linux).toContain(`--remap-path-prefix=%s=${to}`)
    }
    expect(linux).toContain('"${CARGO_HOME:-$HOME/.cargo}" "$(rustc --print sysroot)" "$PWD"')
    // Both the native Linux build and the Mac cross build carry the flags.
    expect(linux.match(/RUSTFLAGS="\$\{RUSTFLAGS:-\} .*\$\(remap_flags\)"/g)).toHaveLength(2)

    const windows = readScript("build-desktop-windows.ts")
    expect(windows).toContain('[[env.CARGO_HOME || join(homedir(), ".cargo"), "/cargo"], [sysroot, "/rust/toolchain"], [root, "/src/interceptor"]]')
    expect(windows).toContain("`--remap-path-prefix=${from}=${to}`")
    expect(windows).toContain('env[rustflagsKey] = [env[rustflagsKey], "-C target-feature=+crt-static", ...remap]')

    const pointer = readScript("build-hyprland-pointer.ts")
    expect(pointer).toContain("`-ffile-prefix-map=${source}=/src/interceptor/interceptor-desktop/hyprland`")
    expect(pointer).toContain("sources:inputs.map(i=>({...i,path:neutral(i.path)}))")
    expect(pointer).toContain("headers:headers.map(h=>({...h,path:neutral(h.path)}))")
  })

  test("packs Linux archives with neutral ownership", () => {
    expect(readScript("release-linux.sh")).toContain(
      'tar --no-xattrs --owner=root:0 --group=root:0 -czf "$RELEASE_DIR/$name.tar.gz"',
    )
  })

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
