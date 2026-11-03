# Starts the farm's hub and the hub's own workers on this PC, hidden, unless they are already running. Run at login from
# the Windows Startup folder (docs/moonshot/checklist.md, farm setup), so a reboot needs only a login to rejoin.
#   powershell -NoProfile -ExecutionPolicy Bypass -File moonshot\tools\farm_hub.ps1
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$py = "C:\Users\debol\miniconda3\envs\jigged\python.exe"
$logs = "C:\jigged-data"
$running = (Get-CimInstance Win32_Process -Filter "Name = 'python.exe'").CommandLine

function Start-Farm($module, $arguments, $log, $key = $module) {
    if ($running -match [regex]::Escape($key)) { return }
    Start-Process -FilePath $py -ArgumentList "-u -m $module $arguments" -WorkingDirectory $repo -WindowStyle Hidden `
        -RedirectStandardOutput "$logs\$log.log" -RedirectStandardError "$logs\$log.err.log"
}

Start-Farm "moonshot.orchestrate.hub" "" "hub"
Start-Sleep -Seconds 5
Start-Farm "moonshot.orchestrate.worker" ("--name hub-gtx1070 --kinds noop,probe,blender_bench,take_render," +
    "encode_frames --gpu-mem 8 --device CUDA --blender C:\blender\blender-5.2.3-windows-x64\blender.exe " +
    "--trainual C:\jigged-data\renderer\trainual") "worker-hub" "--name hub-gtx1070"
# the joins on their own worker too: behind the GPU's frame ranges, a finished take's encode waited for every range
# and the takes' bakes, which waited behind the Macs' vise takes
Start-Farm "moonshot.orchestrate.worker" ("--name hub-cpu --kinds encode_frames,take_bake " +
    "--blender C:\blender\blender-5.2.3-windows-x64\blender.exe") "worker-hub-cpu" "--name hub-cpu"    # Blender encodes
