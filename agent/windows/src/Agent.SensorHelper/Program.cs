using System.Diagnostics;
using SysMon.Agent.Sensors;

// Sensor yardimci sureci. Agent tarafindan Job Object icinde, KATI argumanlarla baslatilir (bkz. HelperArgs).
// M4: uretimde YALNIZ NullSensorProvider (tum sensorler "kullanilamiyor"); gercek LibreHardwareMonitor entegrasyonu ayri,
// kullanici onayli bir kapidir (surucu/yonetici gerektirir). Ortam degiskeni/komut satiri ile saglayici secimi YOKTUR.
//
// Cikis kodlari: 0 normal (ebeveyn cikti), 2 gecersiz arguman/ebeveyn yok, 3 pipe baslatilamadi (ad kapilmis/olusturulamadi), 4 ebeveyn zaten cikmis.
if (!HelperArgs.TryParse(args, out var a) || a is null) return 2;

Process parent;
try { parent = Process.GetProcessById(a.ParentPid); }
catch (ArgumentException) { return 2; }
if (parent.HasExited) return 4;

using var cts = new CancellationTokenSource();
_ = parent.WaitForExitAsync().ContinueWith(_ => cts.Cancel()); // ebeveyn (agent) cikarsa yardimci da cikar: yetim kalmaz

var server = new SensorPipeServer(a.PipeName, new NullSensorProvider(), a.AllowedSid, a.ParentPid, TimeSpan.FromSeconds(2)); // saglayici zaman asimi < istemci okuma zaman asimi (ProviderError yaniti Timeout yolundan once gelir)
try { server.Start(); }
catch (SensorPipeException) { return 3; }

try { await server.RunAsync(cts.Token); }
catch (OperationCanceledException) { }
finally { await server.DisposeAsync(); }
return 0;
