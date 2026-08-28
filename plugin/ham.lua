-- Entry point loaded by Neovim at startup.

if vim.g.loaded_ham then
  return
end
vim.g.loaded_ham = true

-- :Ham [open|close|toggle]  — opens the Google AI Mode chat panel.
vim.api.nvim_create_user_command('Ham', function(args)
  require('ham')._command(args)
end, {
  nargs = '?',
  complete = function()
    return { 'open', 'close', 'toggle', 'login', 'clear', 'retry', 'explain', 'cancel' }
  end,
  desc = 'Open the Google AI Mode chat panel',
})

-- Neovim user commands must start with an uppercase letter, so the real command
-- is :Ham. Make the requested lowercase `:ham` expand to it on the command line.
vim.cmd('cnoreabbrev <expr> ham (getcmdtype() == ":" && getcmdline() ==# "ham") ? "Ham" : "ham"')

-- Detach the backend cleanly when nvim exits (never closes the user's Firefox).
vim.api.nvim_create_autocmd('VimLeavePre', {
  group = vim.api.nvim_create_augroup('ham_shutdown', { clear = true }),
  callback = function()
    pcall(function() require('ham').shutdown() end)
  end,
})
