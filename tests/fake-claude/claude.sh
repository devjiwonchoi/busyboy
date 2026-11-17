#!/bin/sh
# Like Claude Code, one child stays in this process group and one is detached with setsid.
sleep 300 &
grouped=$!
# The detached child writes the pid file after setsid, or a stop can signal it while it is still in the group.
perl -MPOSIX -e '
  POSIX::setsid();
  open(my $file, ">", "$ENV{FAKE_CLAUDE_PID_FILE}.tmp") or die;
  print $file "$ARGV[0] $$\n";
  close($file);
  rename("$ENV{FAKE_CLAUDE_PID_FILE}.tmp", $ENV{FAKE_CLAUDE_PID_FILE}) or die;
  exec "sleep", "301";
' "$grouped" &
cat > /dev/null
