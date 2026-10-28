param([string]$NodePath = (Join-Path $env:ProgramFiles 'nodejs\node.exe'))
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
& (Join-Path $PSScriptRoot 'build.ps1') -NodePath $NodePath
if($LASTEXITCODE -ne 0){throw 'Runtime build failed'}
$dist=Join-Path $PSScriptRoot 'dist'
[IO.Directory]::CreateDirectory($dist)|Out-Null
$stage=Join-Path $PSScriptRoot ('build\package-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stage)|Out-Null
$utf8Bom=New-Object Text.UTF8Encoding($true)
# Only this allowlist enters the binary package. No installed config, token,
# job/output/log directories, personal machine profile or test evidence is copied.
foreach($file in @('nora-bridge.exe','Setup.cmd','README.md','MVP-验收报告.md','client.py','LICENSE-Node.txt','config.example.json')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $stage $file)}
foreach($file in @('Common.ps1','Install.ps1','Start.ps1','Stop.ps1','Status.ps1','Uninstall.ps1','Enable-Firewall.ps1')){
    $content=[IO.File]::ReadAllText((Join-Path $PSScriptRoot ('scripts\'+$file)))
    [IO.File]::WriteAllText((Join-Path $stage $file),$content,$utf8Bom)
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=Join-Path $dist 'NoraBridge-0.1.1-windows-x64.zip'
if(Test-Path -LiteralPath $archive){Remove-Item -LiteralPath $archive -Force}
[IO.Compression.ZipFile]::CreateFromDirectory($stage,$archive,[IO.Compression.CompressionLevel]::Optimal,$false)
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$setup=Join-Path $dist 'NoraBridge-0.1.1-Setup-x64.exe'
& $compiler /nologo /codepage:65001 /target:winexe /platform:x64 /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll (('/resource:')+$archive+',NoraBridge.Payload.zip') (('/out:')+$setup) (Join-Path $PSScriptRoot 'src\setup.cs')
if($LASTEXITCODE -ne 0){throw 'Setup compilation failed'}
$sourceStage=Join-Path $PSScriptRoot ('build\source-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($sourceStage)|Out-Null
$sourceFiles=@('README.md','MVP-验收报告.md','client.py','config.example.json','LICENSE-Node.txt','Setup.cmd','build.ps1','package.ps1','.gitignore','src\main.cjs','src\native-host.cs','src\setup.cs','src\self-test.cjs','test\unit.cjs','test\setup-harness.cs')
foreach($name in @('Common','Install','Start','Stop','Status','Uninstall','Enable-Firewall')){$sourceFiles+=('scripts\'+$name+'.ps1')}
foreach($file in $sourceFiles){
    $target=Join-Path $sourceStage $file
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
    if($file.EndsWith('.ps1')){[IO.File]::WriteAllText($target,[IO.File]::ReadAllText((Join-Path $PSScriptRoot $file)),$utf8Bom)}
    else{Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $target}
}
$sourceArchive=Join-Path $dist 'NoraBridge-0.1.1-source.zip'
if(Test-Path -LiteralPath $sourceArchive){Remove-Item -LiteralPath $sourceArchive -Force}
[IO.Compression.ZipFile]::CreateFromDirectory($sourceStage,$sourceArchive,[IO.Compression.CompressionLevel]::Optimal,$false)
@{stage=$stage;archive=$archive;source_archive=$sourceArchive;setup=$setup;version='0.1.1'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'build\package-info.json') -Encoding UTF8
$checksums=@(Get-FileHash -LiteralPath $archive,$setup,$sourceArchive -Algorithm SHA256|ForEach-Object{$_.Hash.ToLowerInvariant()+'  '+[IO.Path]::GetFileName($_.Path)})
[IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS.txt'),($checksums -join "`n")+"`n",(New-Object Text.UTF8Encoding($false)))
Write-Output ('Payload staging: '+$stage)
Get-FileHash -LiteralPath $archive,$setup,$sourceArchive -Algorithm SHA256|Select-Object Path,Hash
