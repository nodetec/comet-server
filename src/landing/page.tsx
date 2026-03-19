import type { FC } from "hono/jsx"
import type { Release } from "./github"
import { findAsset } from "./github"

const DOWNLOAD_BUTTONS = [
  { label: "macOS ARM", pattern: "aarch64.dmg" },
  { label: "macOS Intel", pattern: "x64.dmg" },
  { label: "Linux AppImage", pattern: ".appimage" },
  { label: "Linux .deb", pattern: ".deb" },
  { label: "Linux .rpm", pattern: ".rpm" },
] as const

export const LandingPage: FC<{ release: Release | null }> = ({ release }) => {
  const tag = release?.tag ?? "latest"
  const fallbackBase = "https://github.com/nodetec/comet/releases/latest"

  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Comet — Capture locally, transmit globally.</title>
        <meta name="description" content="A desktop note-taking app that combines private local storage with the power to publish directly to the Nostr network." />
        <meta property="og:title" content="Comet" />
        <meta property="og:description" content="A desktop note-taking app that combines private local storage with the power to publish directly to the Nostr network." />
        <meta property="og:image" content="/public/demo.png" />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Comet" />
        <meta name="twitter:description" content="A desktop note-taking app that combines private local storage with the power to publish directly to the Nostr network." />
        <meta name="twitter:image" content="/public/demo.png" />
        <link rel="icon" href="/public/comet-logo.svg" />
        <link rel="stylesheet" href="/public/landing.css" />
      </head>
      <body class="antialiased bg-neutral-900 h-full">
        <div class="relative isolate h-full overflow-x-hidden bg-neutral-900">
          {/* Top nav */}
          <nav style="position:absolute;top:0;right:0;z-index:10;padding:1.5rem 1.5rem;display:flex;justify-content:flex-end">
            <a
              id="auth-btn"
              href="/dashboard/login"
              style="border-radius:0.375rem;background:rgba(255,255,255,0.1);padding:0.5rem 1rem;font-size:0.875rem;font-weight:600;color:#fff;text-decoration:none;transition:background 0.15s"
              onmouseover="this.style.background='rgba(255,255,255,0.2)'"
              onmouseout="this.style.background='rgba(255,255,255,0.1)'"
            >
              Sign in
            </a>
          </nav>
          <script dangerouslySetInnerHTML={{__html: `
            (function(){
              try {
                if (localStorage.getItem("pubkey")) {
                  var btn = document.getElementById("auth-btn");
                  btn.textContent = "Dashboard";
                  btn.href = "/dashboard";
                }
              } catch(e) {}
            })();
          `}} />

          {/* Grid background */}
          <svg
            aria-hidden="true"
            class="absolute inset-0 -z-10 size-full stroke-white/10 [mask-image:radial-gradient(100%_100%_at_top_right,white,transparent)]"
          >
            <defs>
              <pattern x="50%" y={-1} id="grid" width={200} height={200} patternUnits="userSpaceOnUse">
                <path d="M.5 200V.5H200" fill="none" />
              </pattern>
            </defs>
            <svg x="50%" y={-1} class="overflow-visible fill-gray-800/20">
              <path d="M-200 0h201v201h-201Z M600 0h201v201h-201Z M-400 600h201v201h-201Z M200 800h201v201h-201Z" stroke-width={0} />
            </svg>
            <rect fill="url(#grid)" width="100%" height="100%" stroke-width={0} />
          </svg>

          {/* Gradient blob */}
          <div
            aria-hidden="true"
            class="absolute top-10 left-[calc(50%-4rem)] -z-10 transform-gpu blur-3xl sm:left-[calc(50%-18rem)] lg:top-[calc(50%-30rem)] lg:left-48 xl:left-[calc(50%-24rem)]"
          >
            <div
              style="clip-path: polygon(73.6% 51.7%, 91.7% 11.8%, 100% 46.4%, 97.4% 82.2%, 92.5% 84.9%, 75.7% 64%, 55.3% 47.5%, 46.5% 49.4%, 45% 62.9%, 50.3% 87.2%, 21.3% 64.1%, 0.1% 100%, 5.4% 51.1%, 21.4% 63.9%, 58.9% 0.2%, 73.6% 51.7%)"
              class="aspect-[1108/632] w-[69.25rem] bg-gradient-to-r from-[#60caf3] to-[#4a42e1] opacity-20"
            />
          </div>

          {/* Hero */}
          <div class="mx-auto max-w-7xl px-6 pt-10 pb-24 sm:pb-32 lg:flex lg:px-8 lg:py-24">
            <div class="mx-auto max-w-2xl shrink-0 lg:mx-0 lg:pt-8">
              {/* Logo + name */}
              <div class="flex items-center gap-3">
                <img alt="Comet logo" src="/public/comet-logo.svg" class="h-11 rounded-md" />
                <span class="text-2xl font-semibold text-white">Comet</span>
                <span class="text-xs font-semibold text-neutral-400 bg-neutral-800 p-1 border rounded-md border-neutral-700">Alpha</span>
                <a href="https://github.com/nodetec/comet" target="_blank" rel="noopener noreferrer" class="text-gray-400 hover:text-white transition-colors">
                  <svg class="size-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clip-rule="evenodd" />
                  </svg>
                </a>
              </div>

              {/* Release badge */}
              <div class="mt-24 sm:mt-32 lg:mt-16">
                <a href="https://github.com/nodetec/comet/releases/latest" class="inline-flex space-x-6">
                  <span class="rounded-full bg-indigo-500/10 px-3 py-1 text-sm/6 font-semibold text-indigo-400 ring-1 ring-indigo-500/20 ring-inset">What's new</span>
                  <span class="inline-flex items-center space-x-2 text-sm/6 font-medium text-gray-300">
                    <span>Latest: {tag}</span>
                    <svg class="size-5 text-gray-500" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" /></svg>
                  </span>
                </a>
              </div>

              <h1 class="mt-10 text-5xl font-semibold tracking-tight text-pretty text-white sm:text-7xl">
                Capture locally, transmit globally.
              </h1>
              <p class="mt-8 text-lg font-medium text-pretty text-gray-400 sm:text-xl/8">
                Comet is a desktop note-taking app that combines private local
                storage with the power to publish directly to the Nostr network.
                Organize with notebooks and tags, write in markdown, and share with
                the world when you're ready.
              </p>

              {/* Download buttons */}
              <div class="mt-10">
                <h2 class="text-2xl font-semibold text-white">Install</h2>
                <div class="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {DOWNLOAD_BUTTONS.map(({ label, pattern }) => {
                    const asset = release ? findAsset(release.assets, pattern) : undefined
                    const href = asset?.url ?? fallbackBase
                    return (
                      <a
                        key={label}
                        href={href}
                        download
                        class="text-center rounded-md bg-indigo-500 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
                      >
                        {label}
                      </a>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* Screenshot */}
            <div class="mx-auto mt-16 flex max-w-2xl sm:mt-24 lg:mt-0 lg:mr-0 lg:ml-10 lg:max-w-none lg:flex-none xl:ml-32">
              <div class="max-w-3xl flex-none sm:max-w-5xl lg:max-w-none">
                <img alt="App screenshot" src="/public/demo.png" width={3040} height={1882} class="w-[76rem]" />
              </div>
            </div>
          </div>

          {/* Features */}
          <div class="bg-neutral-950 py-24 sm:py-32">
            <div class="mx-auto max-w-7xl px-6 lg:px-8">
              <h2 class="text-center text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Built for writers who value ownership
              </h2>
              <dl class="mx-auto mt-16 grid max-w-2xl grid-cols-1 gap-x-8 gap-y-12 sm:grid-cols-2 lg:max-w-none lg:grid-cols-4">
                <div>
                  <dt class="text-base font-semibold text-white">Local-first</dt>
                  <dd class="mt-2 text-sm/6 text-gray-400">Your notes live on your machine. No accounts, no cloud lock-in, no surveillance.</dd>
                </div>
                <div>
                  <dt class="text-base font-semibold text-white">Markdown native</dt>
                  <dd class="mt-2 text-sm/6 text-gray-400">Write in markdown with a live preview editor. Your content stays portable and future-proof.</dd>
                </div>
                <div>
                  <dt class="text-base font-semibold text-white">Publish to Nostr</dt>
                  <dd class="mt-2 text-sm/6 text-gray-400">Share your writing to the Nostr network with one click when you're ready to go public.</dd>
                </div>
                <div>
                  <dt class="text-base font-semibold text-white">Notebooks & tags</dt>
                  <dd class="mt-2 text-sm/6 text-gray-400">Organize your notes into notebooks and tag them for fast filtering and retrieval.</dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Footer */}
          <footer class="border-t border-neutral-800 bg-neutral-950">
            <div class="mx-auto max-w-7xl px-6 py-12 lg:px-8 flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
              <p class="text-sm text-gray-500">&copy; 2025 Comet. Open source under the MIT License.</p>
              <div class="flex gap-6">
                <a href="https://github.com/nodetec/comet" target="_blank" rel="noopener noreferrer" class="text-sm text-gray-500 hover:text-gray-300">GitHub</a>
                <a href="https://github.com/nodetec/comet/releases/latest" target="_blank" rel="noopener noreferrer" class="text-sm text-gray-500 hover:text-gray-300">Releases</a>
                <a href="https://github.com/nodetec/comet/blob/master/LICENSE" target="_blank" rel="noopener noreferrer" class="text-sm text-gray-500 hover:text-gray-300">License</a>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  )
}
