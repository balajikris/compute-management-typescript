import * as msRest from 'ms-rest';
import * as msRestAzure from 'ms-rest-azure';

import ComputeManagementClient = require('azure-arm-compute');
import StorageManagementClient = require('azure-arm-storage');
import NetworkManagementClient = require('azure-arm-network');
import { ResourceManagementClient, ResourceModels } from 'azure-arm-resource';
import * as StorageModels from '../node_modules/azure-arm-storage/lib/models';
import * as ComputeModels from '../node_modules/azure-arm-compute/lib/models';
import * as NetworkModels from '../node_modules/azure-arm-network/lib/models';

class State {
    public clientId: string = process.env['CLIENT_ID'];
    public domain: string = process.env['DOMAIN'];
    public secret: string = process.env['APPLICATION_SECRET'];
    public subscriptionId: string = process.env['AZURE_SUBSCRIPTION_ID'];
    public options: string;
}

class VMSample {
    private resourceGroupName = Helpers.generateRandomId('testrg');
    private vmName = Helpers.generateRandomId('testvm');
    private storageAccountName = Helpers.generateRandomId('testacc');
    private vnetName = Helpers.generateRandomId('testvnet');
    private subnetName = Helpers.generateRandomId('testsubnet');
    private publicIPName = Helpers.generateRandomId('testpip');
    private networkInterfaceName = Helpers.generateRandomId('testnic');
    private ipConfigName = Helpers.generateRandomId('testcrpip');
    private domainNameLabel = Helpers.generateRandomId('testdomainname');
    private osDiskName = Helpers.generateRandomId('testosdisk');

    private location = 'eastus';

    private resourceClient: ResourceManagementClient;
    private computeClient: ComputeManagementClient;
    private storageClient: StorageManagementClient;
    private networkClient: NetworkManagementClient;

    // Ubuntu config
    private ubuntuConfig = {
        publisher: 'Canonical',
        offer: 'UbuntuServer',
        sku: '16.04.0-LTS',
        osType: 'Linux'
    };

    constructor(public state: State) {
    }

    public execute(): void {
        msRestAzure
            .loginWithServicePrincipalSecret(this.state.clientId, this.state.secret, this.state.domain, this.state.options)
            .then((credentials) => {
                this.resourceClient = new ResourceManagementClient(credentials, this.state.subscriptionId);
                this.computeClient = new ComputeManagementClient(credentials, this.state.subscriptionId);
                this.storageClient = new StorageManagementClient(credentials, this.state.subscriptionId);
                this.networkClient = new NetworkManagementClient(credentials, this.state.subscriptionId);
                this.createVM()
                    .then(
                    (vm) => console.log(`VM creation successful: ${JSON.stringify(vm)}`),
                    (err) => console.log(`error creating VM: ${err}`));
            })
            .catch((error) => {
                console.log(`Error occurred: ${error}`)
            });
    }

    private createVM(): Promise<ComputeModels.VirtualMachine> {
        return this.createResourceGroup()
            .then(() => {
                let storageTask = this.createStorageAccount();
                let subnetTask = this.createVnet();
                let nicTask = subnetTask.then(() => this.createNIC());
                return Promise.all([storageTask, subnetTask, nicTask])
                    .then(() => this.createVirtualMachine());
            });
    }

    private createResourceGroup(): Promise<ResourceModels.ResourceGroup> {
        let groupParameters: ResourceModels.ResourceGroup = {
            location: this.location
        };

        console.log(`\n1.Creating resource group: ${this.resourceGroupName}`);

        return this.resourceClient.resourceGroups.createOrUpdate(this.resourceGroupName, groupParameters);
    }

    private createStorageAccount(): Promise<StorageModels.StorageAccount> {
        let storageAcctParams: StorageModels.StorageAccountCreateParameters = {
            location: this.location,
            sku: {
                name: 'Standard_LRS',
            },
            kind: 'storage',
        };

        console.log(`\n2.Creating storage account: ${this.storageAccountName}`);

        return this.storageClient.storageAccounts.create(this.resourceGroupName, this.storageAccountName, storageAcctParams);
    }

    private createVnet(): Promise<NetworkModels.VirtualNetwork> {
        let vnetParams: NetworkModels.VirtualNetwork = {
            location: this.location,
            addressSpace: {
                addressPrefixes: ['10.0.0.0/16']
            },
            dhcpOptions: {
                dnsServers: ['10.1.1.1', '10.1.2.4']
            },
            subnets: [{ name: this.subnetName, addressPrefix: '10.0.0.0/24' }],
        };

        console.log(`\n3.Creating vnet: ${this.vnetName}`);

        return this.networkClient.virtualNetworks.createOrUpdate(this.resourceGroupName, this.vnetName, vnetParams);
    }

    private getSubnetInfo(): Promise<NetworkModels.Subnet> {
        return this.networkClient.subnets.get(this.resourceGroupName, this.vnetName, this.subnetName);
    }

    private createPublicIP(): Promise<NetworkModels.PublicIPAddress> {
        let publicIPParameters: NetworkModels.PublicIPAddress = {
            location: this.location,
            publicIPAllocationMethod: 'Dynamic',
            dnsSettings: {
                domainNameLabel: this.domainNameLabel
            }
        };

        console.log(`\n4.Creating public IP: ${this.publicIPName}`);

        return this.networkClient.publicIPAddresses.createOrUpdate(this.resourceGroupName, this.publicIPName, publicIPParameters);
    }

    private createNIC(): Promise<NetworkModels.NetworkInterface> {
        let subnetTask = this.getSubnetInfo();
        let ipTask = this.createPublicIP();

        return Promise.all([subnetTask, ipTask])
            .then(([s, ip]) => {
                console.log(`\n5.Creating Network Interface: ${this.networkInterfaceName}`);

                let subnet: NetworkModels.Subnet = s;
                let publicIp: NetworkModels.PublicIPAddress = ip;
                let nicParameters = {
                    location: this.location,
                    ipConfigurations: [
                        {
                            name: this.ipConfigName,
                            privateIPAllocationMethod: 'Dynamic',
                            subnet: subnet,
                            publicIPAddress: publicIp
                        }
                    ]
                };

                return this.networkClient.networkInterfaces.createOrUpdate(this.resourceGroupName, this.networkInterfaceName, nicParameters);
            });
    }

    private findVMImage(): Promise<ComputeModels.VirtualMachineImageResource[]> {
        return this.computeClient.virtualMachineImages.list(this.location,
            this.ubuntuConfig.publisher,
            this.ubuntuConfig.offer,
            this.ubuntuConfig.sku,
            { top: 1 });
    }

    private getNICInfo(): Promise<NetworkModels.NetworkInterface> {
        return this.networkClient.networkInterfaces.get(this.resourceGroupName, this.networkInterfaceName);
    }

    private createVirtualMachine(): Promise<ComputeModels.VirtualMachine> {
        let nicTask = this.getNICInfo();
        let findVMTask = this.findVMImage();

        return Promise.all([nicTask, findVMTask])
            .then(([nic, img]) => {

                let nicId: string = nic.id;
                let vmImageVersionNumber: string = img[0].name;

                let osProfile: ComputeModels.OSProfile = {
                    computerName: this.vmName,
                    adminUsername: 'notadmin',
                    adminPassword: 'Pa$$w0rd92234'
                };

                let hardwareProfile: ComputeModels.HardwareProfile = {
                    vmSize: 'Basic_A0'
                };

                let imageReference: ComputeModels.ImageReference = {
                    publisher: this.ubuntuConfig.publisher,
                    offer: this.ubuntuConfig.offer,
                    sku: this.ubuntuConfig.sku,
                    version: vmImageVersionNumber
                };

                let osDisk: ComputeModels.OSDisk = {
                    name: this.osDiskName,
                    caching: 'None',
                    createOption: 'fromImage',
                    // vhd: { uri: 'https://' + this.storageAccountName + '.blob.core.windows.net/nodejscontainer/osnodejslinux.vhd' }
                };

                let storageProfile: ComputeModels.StorageProfile = {
                    imageReference: imageReference,
                    osDisk: osDisk
                };

                let networkProfile: ComputeModels.NetworkProfile = {
                    networkInterfaces: [
                        {
                            id: nicId,
                            primary: true
                        }
                    ]
                };

                let vmParameters: ComputeModels.VirtualMachine = {
                    location: this.location,
                    osProfile: osProfile,
                    hardwareProfile: hardwareProfile,
                    storageProfile: storageProfile,
                    networkProfile: networkProfile
                };

                console.log(`\n6.Creating Virtual Machine: ${this.vmName}`);

                return this.computeClient.virtualMachines.createOrUpdate(
                    this.resourceGroupName,
                    this.vmName,
                    vmParameters);
            });
    }
}

class Helpers {
    static generateRandomId(prefix: string): string {
        return prefix + Math.floor(Math.random() * 10000);
    }

    static validateEnvironmentVariables(): void {
        let envs = [];
        if (!process.env['CLIENT_ID']) envs.push('CLIENT_ID');
        if (!process.env['DOMAIN']) envs.push('DOMAIN');
        if (!process.env['APPLICATION_SECRET']) envs.push('APPLICATION_SECRET');
        if (!process.env['AZURE_SUBSCRIPTION_ID']) envs.push('AZURE_SUBSCRIPTION_ID');
        if (envs.length > 0) {
            throw new Error(`please set/export the following environment variables: ${envs.toString()}`);
        }
    }
}

main();

function main() {
    Helpers.validateEnvironmentVariables();
    let state = new State();
    let driver = new VMSample(state);
    driver.execute();
}
