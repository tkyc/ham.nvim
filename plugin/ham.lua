-- Entry point loaded by Neovim at startup.

if vim.g.loaded_ham then
  return
end
vim.g.loaded_ham = true

-- :Ham [subcommand]  — opens the Google AI Mode chat panel.
-- :Ham <query>       — asks <query> about your last yank.
vim.api.nvim_create_user_command('Ham', function(args)
  require('ham')._command(args)
end, {
  nargs = '?',
  complete = function(arg_lead, cmd_line)
    -- Only the first word is a subcommand; past it you're typing a free-form query.
    if cmd_line:match('^%s*%S+%s+%S+%s') then return {} end
    -- A function `complete` uses customlist semantics: Neovim does NOT filter the
    -- returned list by what's typed, so narrow it to the prefix ourselves.
    return vim.tbl_filter(function(s) return vim.startswith(s, arg_lead) end, require('ham').subcommands())
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
