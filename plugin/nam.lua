-- Entry point loaded by Neovim at startup.

if vim.g.loaded_nam then
  return
end
vim.g.loaded_nam = true

-- :Nam [open|close|toggle]  — opens the Google AI Mode chat panel.
vim.api.nvim_create_user_command('Nam', function(args)
  require('nam')._command(args)
end, {
  nargs = '?',
  complete = function()
    return { 'open', 'close', 'toggle' }
  end,
  desc = 'Open the Google AI Mode chat panel',
})

-- Neovim user commands must start with an uppercase letter, so the real command
-- is :Nam. Make the requested lowercase `:nam` expand to it on the command line.
vim.cmd('cnoreabbrev <expr> nam (getcmdtype() == ":" && getcmdline() ==# "nam") ? "Nam" : "nam"')

-- Detach the backend cleanly when nvim exits (never closes the user's Firefox).
vim.api.nvim_create_autocmd('VimLeavePre', {
  group = vim.api.nvim_create_augroup('nam_shutdown', { clear = true }),
  callback = function()
    pcall(function() require('nam').shutdown() end)
  end,
})
