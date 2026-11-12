namespace Agent.Tests;

/// <summary>
/// GC.GetTotalMemory ile bellek olcen K3 testi surec geneli duruma duyarlidir; bu koleksiyon DIGER TUM test siniflariyla
/// paralel kosmayi kapatir (inceleme MIN-03: yalnizca [Collection] etiketi paralelligi kapatmaz, tanim gerekir).
/// </summary>
[CollectionDefinition("NonParallelSpoolMemory", DisableParallelization = true)]
public class NonParallelSpoolMemoryCollection;
