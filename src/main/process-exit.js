function getProcessExitEvents(profileId, code, stderr) {
  const failed = Number.isInteger(code) && code !== 0;
  return {
    error: failed ? { profileId, error: `BotBrowser exited with code ${code}`, code, stderr } : null,
    stopped: { profileId, code, stderr: failed ? stderr : undefined }
  };
}

module.exports = { getProcessExitEvents };
