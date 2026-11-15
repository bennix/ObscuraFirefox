const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
function pipeCommand(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve({ stdout }) : reject(new Error('Secure credential storage is unavailable. On Linux, unlock the Secret Service keyring.')));
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}
async function secureStore(command, args) {
  if (process.platform === 'darwin') return execute(command, args);
  const value = flag => args[args.indexOf(flag) + 1];
  const service = value('-s'), account = value('-a');
  const action = { 'find-generic-password': 'read', 'add-generic-password': 'write', 'delete-generic-password': 'delete' }[args[0]];
  if (!action) throw new Error('Unsupported credential operation');
  if (process.platform === 'linux') {
    const attributes = ['service', service, 'account', account];
    return pipeCommand('secret-tool', action === 'write' ? ['store', '--label=Obscura Firefox', ...attributes] : [action === 'read' ? 'lookup' : 'clear', ...attributes], action === 'write' ? value('-w') : '');
  }
  if (process.platform !== 'win32') throw new Error('Unsupported credential platform');
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$d=[Console]::In.ReadToEnd() | ConvertFrom-Json
$entropy=[Text.Encoding]::UTF8.GetBytes($d.service+':'+$d.account)
$sha=[Security.Cryptography.SHA256]::Create()
$name=([BitConverter]::ToString($sha.ComputeHash($entropy))).Replace('-','')+'.enc'
$dir=Join-Path $env:APPDATA 'Obscura Firefox/secrets'
[IO.Directory]::CreateDirectory($dir) | Out-Null
$file=Join-Path $dir $name
if($d.action -eq 'write') {
 $bytes=[Text.Encoding]::UTF8.GetBytes($d.secret)
 $cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [IO.File]::WriteAllBytes($file,$cipher)
} elseif($d.action -eq 'read') {
 $plain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
} elseif([IO.File]::Exists($file)) {[IO.File]::Delete($file)}
`;
  return pipeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], JSON.stringify({ action, service, account, secret: action === 'write' ? value('-w') : '' }));
}
module.exports = { secureStore };
