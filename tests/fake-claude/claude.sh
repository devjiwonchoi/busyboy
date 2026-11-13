#!/bin/sh
# Stands in for the Claude CLI in journeys that run the real adapter. Like a
# CLI with an MCP server and a running Bash command, it starts one child in
# its own process group and one detached into a session of its own (as Claude
# Code starts its commands), writes both pids to $FAKE_CLAUDE_PID_FILE, and
# then waits until its input closes.
sleep 300 &
grouped=$!
# The detached child writes the pid file itself, after setsid: written any
# earlier, a stop on a slow machine could signal the group while the child is
# still in it and miss it once it has left.
perl -MPOSIX -e '
  POSIX::setsid();
  open(my $file, ">", "$ENV{FAKE_CLAUDE_PID_FILE}.tmp") or die;
  print $file "$ARGV[0] $$\n";
  close($file);
  rename("$ENV{FAKE_CLAUDE_PID_FILE}.tmp", $ENV{FAKE_CLAUDE_PID_FILE}) or die;
  exec "sleep", "301";
' "$grouped" &
cat > /dev/null
