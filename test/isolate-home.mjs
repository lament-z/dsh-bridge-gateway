// 测试隔离引导：把 DSH_HOME 指向一次性临时目录。
//
// 为什么需要：部分测试会构造 AuthManager / BridgeService 等对象，它们默认在
// $DSH_HOME 下读写状态（如 dsh-bridge/sessions.json）。若不隔离，跑一次测试就会
// 在真实的 ~/.dsh 里留下/覆盖文件。
//
// 用法：node --import ./test/isolate-home.mjs --test test/*.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.DSH_TEST_HOME_ISOLATED) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-test-home-'))
  process.env.DSH_TEST_HOME_ISOLATED = '1'
}
