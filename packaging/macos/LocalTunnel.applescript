-- Compiled as a stay-open applet, so the app keeps a Dock icon while the service runs and Quit stops it.
on run
	openConsole()
end run

on reopen
	openConsole()
end reopen

on quit
	try
		do shell script launcherCommand("stop")
	end try
	continue quit
end quit

on openConsole()
	try
		do shell script launcherCommand("start")
	on error errorMessage
		display alert "Local Tunnel" message errorMessage as critical
	end try
end openConsole

-- Apps opened from Finder get a minimal PATH. Commands run for the AI inherit this one, so use the login shell's.
on launcherCommand(action)
	set appDirectory to POSIX path of (path to me) & "Contents/Resources/app/"
	return "export PATH=\"$(/bin/zsh -lc 'print -r -- $PATH' 2>/dev/null):$PATH\"; cd " & quoted form of appDirectory & " && ./runtime/node src/launcher.js " & action
end launcherCommand
