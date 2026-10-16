import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import pkg from "../package.json"
import manifest from "../extension/manifest.json"
import electronManifest from "../extension/dist-mv2/manifest.json"
import { VERSION } from "../cli/version"


describe("version sync", () => {
  test("source CLI version matches package.json#version", () => {
    expect(VERSION).toBe(pkg.version)
  })

  test("extension/manifest.json#version matches package.json#version", () => {
    expect(manifest.version).toBe(pkg.version)
  })

  test("Electron/MV2 manifest version matches package.json#version", () => {
    expect(electronManifest.version).toBe(pkg.version)
  })

  test("Safari app and extension versions match package.json#version", () => {
    const project = readFileSync(resolve(import.meta.dir, "../safari/InterceptorSafari/InterceptorSafari.xcodeproj/project.pbxproj"), "utf8")
    for (const key of ["MARKETING_VERSION", "CURRENT_PROJECT_VERSION"]) {
      const versions = [...project.matchAll(new RegExp(`${key} = ([^;]+);`, "g"))].map(match => match[1])
      expect(versions).toEqual(Array(4).fill(pkg.version))
    }
  })

  test("native desktop provider version matches package.json#version", () => {
    // The provider reports CARGO_PKG_VERSION, and the installers and release scripts compare it to the package version.
    type Package = { name: string; version: string }
    const desktop = (name: string) => Bun.TOML.parse(readFileSync(resolve(import.meta.dir, "../interceptor-desktop", name), "utf8")) as { package: Package | Package[] }
    expect((desktop("Cargo.toml").package as Package).version).toBe(pkg.version)
    const locked = (desktop("Cargo.lock").package as Package[]).filter(p => p.name === "interceptor-desktop")
    expect(locked.map(p => p.version)).toEqual([pkg.version])
  })
})
