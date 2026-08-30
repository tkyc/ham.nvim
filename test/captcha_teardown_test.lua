-- Test that abandoning a query while a captcha is being solved never strands Firefox in
-- its visible (headful) solver state. Two teardown paths must clean up:
--   #1  :Ham clear / /clear  -> backend.reset()      (was the bug: it dropped the handler
--       without aborting the solve-wait or flipping Firefox back)
--   #4  the backend process crashing mid-solve -> on_exit
-- Both must, for any in-flight handler parked on a captcha, restore Firefox once (flip to
-- headless in browser mode; fully quit it in http-disk mode).
--
-- Drives the REAL protocol dispatch (backend._dispatch / backend._on_exit test seams) so
-- the actual ECAPTCHA -> open-solver -> awaiting_captcha state is set up exactly as in
-- production, with Firefox + stdout stubbed so nothing real launches.
--
--   nvim --headless -l test/captcha_teardown_test.lua   (exits 0 on success, 1 on failure)

local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':h:h')
vim.opt.runtimepath:append(root)
vim.cmd('runtime plugin/ham.lua')

local backend = require('ham.backend')
local firefox = require('ham.firefox')

local failures = {}
local function check(name, got, want)
  local ok = got == want
  print(string.format('%-58s got=%-6s want=%-6s %s', name, tostring(got), tostring(want), ok and 'OK' or 'FAIL'))
  if not ok then table.insert(failures, name) end
end

-- Firefox stubs: count the restore calls; never touch a real browser. open_solver invokes
-- its callback synchronously with success, so the ECAPTCHA dispatch sets awaiting_captcha.
local ff = { open_solver = 0, to_headless = 0, quit = 0, restart = 0 }
firefox.open_solver = function(cb) ff.open_solver = ff.open_solver + 1; if cb then cb(true) end end
firefox.to_headless = function(cb) ff.to_headless = ff.to_headless + 1; if cb then cb(true) end end
firefox.quit = function(cb) ff.quit = ff.quit + 1; if cb then cb() end end
firefox.restart = function(cb) ff.restart = ff.restart + 1; if cb then cb(true) end end

-- Capture what the backend would write to the Node process instead of spawning it.
local sent = {}
backend._send = function(obj) table.insert(sent, obj); return true end
local function sent_has(kind, id)
  for _, o in ipairs(sent) do if o.type == kind and (id == nil or o.id == id) then return true end end
  return false
end
local function count_sent(kind)
  local n = 0; for _, o in ipairs(sent) do if o.type == kind then n = n + 1 end end; return n
end

-- Set up a query parked on a captcha solve, exactly as production dispatch would. Returns
-- the handler table (whose awaiting_captcha the teardown paths must act on).
local function park_on_captcha(opts)
  require('ham').setup(opts)
  backend._dispatch({ type = 'ready' }) -- mark the (stubbed) backend ready so query sends now
  local h = { on_chunk = function() end, on_error = function(m) h_last_error = m end }
  local id = backend.query('a slow question', h)
  backend._dispatch({ type = 'error', id = id, code = 'ECAPTCHA', message = 'captcha' })
  return h, id
end

-- ── #1: /clear (backend.reset) during a browser-mode captcha solve ──────────────────────
do
  local h, id = park_on_captcha({ firefox = { manage = true }, backend = { port = 9999, mode = 'browser' } })
  check('browser: parked on captcha (awaiting_captcha set)', h.awaiting_captcha, true)
  local sends0 = count_sent('cancel')
  local flips0 = ff.to_headless
  backend.reset()
  check('browser reset aborts the captcha solve-wait (cancel sent for that id)', sent_has('cancel', id), true)
  check('browser reset sent exactly one new cancel', count_sent('cancel') - sends0, 1)
  check('browser reset flips Firefox back to headless', ff.to_headless - flips0, 1)
  check('browser reset still starts a fresh conversation', sent_has('reset'), true)
end

-- ── #1: /clear (backend.reset) during an http-disk-mode captcha solve ───────────────────
do
  local prof = vim.fn.tempname()
  local h, id = park_on_captcha({ firefox = { manage = true, profile = prof }, backend = { port = 9999, mode = 'http' } })
  check('http-disk: parked on captcha (awaiting_captcha set)', h.awaiting_captcha, true)
  local quits0 = ff.quit
  backend.reset()
  check('http-disk reset aborts the captcha solve-wait (cancel sent)', sent_has('cancel', id), true)
  check('http-disk reset fully QUITS Firefox (cookies read from disk after)', ff.quit - quits0, 1)
end

-- ── #4: backend process crash (on_exit) during a browser-mode captcha solve ─────────────
do
  h_last_error = nil
  local h = park_on_captcha({ firefox = { manage = true }, backend = { port = 9999, mode = 'browser' } })
  check('crash case: parked on captcha (awaiting_captcha set)', h.awaiting_captcha, true)
  local flips0 = ff.to_headless
  backend._on_exit(nil, 1) -- simulate a non-deliberate backend exit (crash) with no live job
  check('backend crash mid-solve flips Firefox back to headless', ff.to_headless - flips0, 1)
  check('backend crash fails the in-flight handler', type(h_last_error) == 'string', true)
end

if #failures == 0 then
  print('\nALL PASS')
  os.exit(0)
else
  print('\nFAILURES: ' .. table.concat(failures, ', '))
  os.exit(1)
end
