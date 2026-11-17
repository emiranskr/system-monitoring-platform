namespace SysMon.Agent.Hardware;

/// <summary>GPU okuma sirasinda/sonrasinda kayboldu (GPU_IS_LOST, surucu reseti, gecersiz tutamak). Kismi/eskimis veri yayinlanmaz.</summary>
public sealed class GpuLostException(string message) : Exception(message);

/// <summary>Onceki bir native cagri hala surdugu icin (bloklu surucu) yeni cagri kabul edilmedi; cagrilar yigilmaz.</summary>
public sealed class GpuProviderBusyException() : Exception("GPU saglayicisi mesgul: onceki native cagri tamamlanmadi");
