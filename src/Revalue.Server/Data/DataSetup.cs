using Azure.Identity;
using Microsoft.Azure.Cosmos;

namespace Revalue.Server.Data;

public static class DataSetup
{
    /// <summary>
    /// 保存先を登録する。Cosmos:Endpoint があれば Cosmos DB（マネージド ID で接続）、なければインメモリ。
    /// 本番（Production）で Cosmos:Endpoint がなければ、データが残らないまま動き続けないよう起動を止める。
    /// </summary>
    public static IServiceCollection AddRevalueData(this IServiceCollection services, IConfiguration config, IHostEnvironment environment)
    {
        var endpoint = config["Cosmos:Endpoint"];
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            if (environment.IsProduction())
            {
                throw new InvalidOperationException("Cosmos:Endpoint is required in Production.");
            }

            services.AddSingleton<IDataStore, InMemoryDataStore>();
            return services;
        }

        var database = config["Cosmos:Database"] ?? "revalue";
        var containerName = config["Cosmos:Container"] ?? "items";
        services.AddSingleton(_ => new CosmosClient(
            endpoint,
            new DefaultAzureCredential(),
            new CosmosClientOptions { ApplicationName = "revalue" }));
        services.AddSingleton<IDataStore>(sp =>
            new CosmosDataStore(sp.GetRequiredService<CosmosClient>().GetContainer(database, containerName)));
        return services;
    }
}
