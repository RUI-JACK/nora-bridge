param([string]$NodePath = (Join-Path $env:ProgramFiles 'nodejs\node.exe'))
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath $NodePath)) { throw 'Node.js 24 is required for building only.' }
$nodeBuild = (& $NodePath -p 'JSON.stringify({version:process.versions.node,arch:process.arch})') | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $nodeBuild.version -notmatch '^24\.' -or $nodeBuild.arch -ne 'x64') { throw 'Build requires Node.js 24 x64.' }
$build = Join-Path $PSScriptRoot 'build'
[IO.Directory]::CreateDirectory($build) | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /codepage:65001 /target:winexe /platform:x64 /r:System.Web.Extensions.dll (('/out:')+(Join-Path $build 'native-host.exe')) (Join-Path $PSScriptRoot 'src\native-host.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native host compilation failed' }
$config = @{
    main=(Join-Path $PSScriptRoot 'src\main.cjs')
    output=(Join-Path $build 'nora.blob')
    disableExperimentalSEAWarning=$true
    useSnapshot=$false
    useCodeCache=$false
    execArgvExtension='none'
    assets=@{'native-host.exe'=(Join-Path $build 'native-host.exe');'self-test.cjs'=(Join-Path $PSScriptRoot 'src\self-test.cjs')}
}
[IO.File]::WriteAllText((Join-Path $build 'sea-config.json'), ($config | ConvertTo-Json -Depth 5), $utf8)
& $NodePath --check (Join-Path $PSScriptRoot 'src\main.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Syntax check failed' }
& $NodePath --experimental-sea-config (Join-Path $build 'sea-config.json')
if ($LASTEXITCODE -ne 0) { throw 'SEA preparation failed' }
$finalExe = Join-Path $PSScriptRoot 'nora-bridge.exe'
$exe = Join-Path $build ('staging-'+[guid]::NewGuid().ToString('N')+'.exe')
Copy-Item -LiteralPath $NodePath -Destination $exe -Force
# Use the Windows resource API instead of downloading a resource injector.
# Node's SEA PE reader expects a resource named NODE_SEA_BLOB of type RCDATA.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NoraResource {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr BeginUpdateResource(string file,bool delete);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool UpdateResource(IntPtr h,IntPtr type,string name,ushort lang,byte[] data,uint len);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool EndUpdateResource(IntPtr h,bool discard);
}
'@
$h = [NoraResource]::BeginUpdateResource($exe, $false)
if ($h -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
$blob = [IO.File]::ReadAllBytes((Join-Path $build 'nora.blob'))
if (-not [NoraResource]::UpdateResource($h, [IntPtr]10, 'NODE_SEA_BLOB', 0, $blob, $blob.Length)) {
    [NoraResource]::EndUpdateResource($h, $true) | Out-Null
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
if (-not [NoraResource]::EndUpdateResource($h, $false)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
$bytes = [IO.File]::ReadAllBytes($exe)
$fuse = [Text.Encoding]::ASCII.GetBytes('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0')
# Byte matching via Latin1 avoids PowerShell's slow per-byte scans of a 90 MB PE.
$latin = [Text.Encoding]::GetEncoding(28591)
$text = $latin.GetString($bytes)
$index = $text.IndexOf($latin.GetString($fuse), [StringComparison]::Ordinal)
if ($index -lt 0 -or $text.IndexOf($latin.GetString($fuse), $index+1, [StringComparison]::Ordinal) -ge 0) { throw 'SEA fuse missing or ambiguous' }
$bytes[$index+$fuse.Length-1] = [byte][char]'1'
$pe = [BitConverter]::ToInt32($bytes, 0x3c)
$optional = $pe + 24
if ([BitConverter]::ToUInt16($bytes,$optional) -ne 0x20b) { throw 'Expected an x64 PE32+ Node binary' }
# IMAGE_SUBSYSTEM_WINDOWS_GUI: no console window even on direct EXE startup.
[BitConverter]::GetBytes([uint16]2).CopyTo($bytes, $optional+68)
# The modified file is unsigned. Clear the Authenticode directory and checksum.
[Array]::Clear($bytes, $optional+112+8*4, 8)
[Array]::Clear($bytes, $optional+64, 4)
[IO.File]::WriteAllBytes($exe, $bytes)
Move-Item -LiteralPath $exe -Destination $finalExe -Force
Get-FileHash -LiteralPath $finalExe -Algorithm SHA256 | Select-Object Path,Hash
