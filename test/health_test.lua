-- Test the :checkhealth ham query-mode line. In http mode it must reflect the ACTUAL
-- cookie source: "Firefox only for login + captcha" is true only on a dedicated on-disk
-- profile; on the shared default profile every query harvests cookies from a running
-- Firefox, so the top line must say so (it used to contradict its own cookie line).
--
--   nvim --headless -l test/health_test.lua   (exits 0 on success, 1 on failure)

local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':h:h')
vim.opt.runtimepath:append(root)

-- Stub vim.health BEFORE requiring ham.health (it binds h_ok/h_warn/... at require time).
local recorded = {}
vim.health = {
  start = function() end,
  ok = function(s) table.insert(recorded, s) end,
  warn = function(s) table.insert(recorded, s) end,
  error = function(s) table.insert(recorded, s) end,
}

vim.cmd('runtime plugin/ham.lua')

local failures = {}
local function check(name, got, want)
  local ok = got == want
  print(string.format('%-58s got=%-6s want=%-6s %s', name, tostring(got), tostring(want), ok and 'OK' or 'FAIL'))
  if not ok then table.insert(failures, name) end
end

local function mode_line()
  for _, msg in ipairs(recorded) do
    if msg:find('query mode', 1, true) then return msg end
  end
  return ''
end

-- http + dedicated on-disk profile → Firefox genuinely only needed for login / captcha.
recorded = {}
require('ham').setup({ backend = { mode = 'http' }, firefox = { profile = '/nonexistent/ham/firefox' } })
require('ham.health').check()
check('http+disk: mode line mentions "only for login + captcha"',
  mode_line():find('only for login + captcha', 1, true) ~= nil, true)

-- http + shared default profile → cookies harvested from a running Firefox each query.
recorded = {}
require('ham').setup({ backend = { mode = 'http' }, firefox = { profile = '' } })
require('ham.health').check()
check('http+shared: mode line does NOT claim login+captcha-only',
  mode_line():find('only for login + captcha', 1, true) == nil, true)
check('http+shared: mode line says cookies come from a running Firefox',
  mode_line():find('harvested from a running Firefox', 1, true) ~= nil, true)

if #failures == 0 then
  print('\nALL PASS')
  os.exit(0)
else
  print('\nFAILURES: ' .. table.concat(failures, ', '))
  os.exit(1)
end
