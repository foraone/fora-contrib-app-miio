const axios = require('axios');
const mqtt = require('async-mqtt');
const miio = require('./lib');
const config = require('./config');
const configurationSchema = require('./schemas');

const typeConverter = {
    boolean: {
        type: "Boolean"
    },
    percentage: {
        type: "Number",
        min: 0,
        max: 100,
        measurementUnit: "%"
    },
    illuminance: {
        type: "Number",
        measurementUnit: "Lx"
    },
    power: {
        type: "Number",
        measurementUnit: "W"
    },
    energy: {
        type: "Number",
        measurementUnit: "Wh"
    },
    color: {
        type: "RGB"
    },
    mixed: {
        type: "String"
    }

}

function lowerFirst(string) 
{
    return string.charAt(0).toLowerCase() + string.slice(1);
}

function upperFirst(string) 
{
    return string.charAt(0).toUpperCase() + string.slice(1);
}

class Application {
    constructor() {
        /* internal vars */
        this.appParams = {};
        this.mqttConnected = false;
        this.miioConnected = false;
        this.tokens = {};
        this.foraDevices = [];
        this.miioDevices = {};
        this.browser = null;
        this.subscibedTopics = [];
        /* some constants */
        this.logTopic = `apps/${config.appId}/log`;
        this.commandTopic = `apps/${config.appId}/command`;
        this.notifyTopic = `apps/${config.appId}/notify`;

        /* */
        this.client = mqtt.connect(config.foraMQTT, {
            username: `app:${config.appId}`,
            password: config.appToken,
            will: {
                topic: `apps/${config.appId}/online`,
                payload: "false",
                retain: true
            }
        });
        this.onForaMessage = this.onForaMessage.bind(this);
        this.onForaConnected = this.onForaConnected.bind(this);
        this.onForaReconnect = this.onForaReconnect.bind(this);
        this.onForaDisconnect = this.onForaDisconnect.bind(this);
        this.onForaOffline = this.onForaOffline.bind(this);
        this.onForaOffline = this.onForaOffline.bind(this);
        this.miioDeviceFound = this.miioDeviceFound.bind(this)

        this.client.on('message', this.onForaMessage )
        this.client.on('connect', this.onForaConnected )
        this.client.on('reconnect', this.onForaReconnect )
        this.client.on('disconnect', this.onForaDisconnect )
        this.client.on('offline', this.onForaOffline )
        this.client.on('error', this.onForaError)   
    }

    async start(){
        //const strConfig = JSON.stringify(configurationSchema);
        
        const result = await axios({
            method: 'POST',
            url: `${config.foraAPI}/api/v1/apps/${config.appId}/setConfigSchema`, 
            data: {config: configurationSchema},
            headers: { 
                'Authorization': `Bearer ${config.appToken}`
            }
        });
        this.readConfig();
        //console.log(result.data)
       
    }

    disconnectMiio(){
        this.browser.stop()
        delete this.browser;
        /** TODO: REMOVE MIIO DEVICES */
    }

    connectToMiio() {
        if (this.miioConnected) {
            this.disconnectMiio()
        }

        //console.log("Connecting Miio with tokens: ", this.tokens)
        this.browser = miio.browse({
            cacheTime: 300,
            useTokenStorage: false,
            //tokens: this.tokens
        });
        this.browser.on('available', this.miioDeviceFound)
    }



    miioDeviceFound(reg) {
        if (this.tokens[reg.id]) {
            reg.token = this.tokens[reg.id]
        }
        if(! reg.token ) {
            console.log(reg.id, 'hides its token and not configured in FORA');
            return
        }

        miio.device(reg).then(device => {
           

            this.miioDevices[device.id] = device;
            this.updateForaDevice(device);
            

            //device.state().then(state=>{console.log("STATE:", state)})
            //device.on('propertyChanged', e => console.log("GATEWAY PROP FROM TO:", device.id, e.property, e.oldValue, e.value));
            //device.on('propertiesChanged', e=> console.log("Props", e))
            //device.on('stateChanged', change => console.log("STATE CHANGED", device.id, change));
            if (device.children) {
                const children = device.children();
                
                for(const child of children) {
                    this.updateForaDevice(child)
                    this.miioDevices[child.id] = child;
                    //console.log(child.id, child); // Do something with each child
                    //child.on('propertyChanged', e => console.log("CHILD PROP:", child, e.property, e.oldValue, e.value));
                    //child.on('batteryChanged', (change, thing) => console.log("CHILD CHANGED", change, thing.id));
                    //child.on('contactChanged', (change, thing) => console.log("CHILD CHANGED", change, thing.id));

                }
            }
            
            // console.log("PROPS:", device._properties)
            // console.log("METADATA",device.metadata)
        });
    }

    async registerForaDevice(foraDevice) {
        console.log("Registering fora device:", JSON.stringify(foraDevice,null, 4))
        this.foraDevices.push({isRegistering: true, ...foraDevice})

        const result = await axios({
            method: 'POST',
            url: `${config.foraAPI}/api/v1/devices`, 
            data: foraDevice,
            headers: { 
                'Authorization': `Bearer ${config.appToken}`
            }
        });
        console.log("REGISTERED==========<", result.data)
    }

    updateForaDevice(miioDevice) {
        let deviceDPs = {};
        Object.keys(miioDevice.metadata.actions).forEach(key=>{
            if (key.indexOf('set') === 0) {

                let actKey = lowerFirst(key.slice(3))
                if (!deviceDPs[actKey]) deviceDPs[actKey] = {}
                deviceDPs[actKey].action = key
                deviceDPs[actKey].type = miioDevice.metadata.actions[key].returnType.type
                deviceDPs[actKey].actionDescription = miioDevice.metadata.actions[key].description
                
            }
        })


        Object.keys(miioDevice.metadata.events).forEach(key=>{
            if (key.endsWith('Changed')) {
                let actKey = lowerFirst(key.slice(0,-7));
                if (!deviceDPs[actKey]) {
                    deviceDPs[actKey] = {}
                }
                if (!deviceDPs[actKey].type) {
                    deviceDPs[actKey].type = miioDevice.metadata.events[key].type
                }
                
                deviceDPs[actKey].event = key
            }
        })

        Object.keys(deviceDPs).forEach(key=>{
            if (!deviceDPs[key].type && !!miioDevice.metadata.state[key]) {
                deviceDPs[key].type = miioDevice.metadata.state[key].type
            }  
        })

        delete deviceDPs['state']
        if (miioDevice.id == 'miio:158d0001016c3c') {
            console.log('============!!!===============')
            //console.log("Update Device:", miioDevice.id, miioDevice.metadata)
            console.log(deviceDPs)
        }
        const self = this;
        Object.keys(deviceDPs).forEach(key=>{
            const event = deviceDPs[key].event;
            
            if (event) {

                miioDevice.on(event, async (data, d)=>{
                    // d.id = foraDevice type
                    const fd = self.foraDevices.find(fd=>fd.general.type === d.id)
                    let ignore = false;
                    if (fd) {
                        if (event == 'powerConsumedChanged') {
                        console.log("::","*","-",event,"<===>", data)
                        }
                        if (typeof data === "object") {
                            if (data.hasOwnProperty('value')){
                                data = data.value
                                if (isNaN(data)) ignore = true
                            } else {
                                data = JSON.stringify(data);
                            }   
                        }
                        
                        const dp = fd.datapoints.find(dp=>dp.name===key)
                        //console.log(dp)
                        //console.log("----PUBLISING:",`dps/${dp._id}`, `${data}`, {retain: true} )
                        if (!ignore) {
                            this.client.publish(`dps/${dp._id}`, `${data}`, {retain: true})
                        } else {
                            console.log("----------IGNORE")
                        }
                    }
                    console.log(miioDevice.id, event, data, d.id)
                })
            }
        })
        if (miioDevice.id == 'miio:158d0001016c3c') {
            console.log('===========================')
            console.log("Update Device:", miioDevice.id)
            
            // console.log(Object.keys(miioDevice))
            // console.log('---------------------------')
            // console.log(Object.keys(miioDevice.metadata))
            console.log('TYPES----------------------')
            console.log(miioDevice.metadata.types)
            console.log('CAPAB----------------------')
            console.log(miioDevice.metadata.capabilities)
            console.log("EVENTS---------------------")
            console.log(miioDevice.metadata.events)
            console.log("STATE----------------------")
            console.log(miioDevice.metadata.state)
            console.log("ACTIONS--------------------")
            console.log(JSON.stringify(miioDevice.metadata.actions,null,"\t"))
        }
        // console.log("---------------------------")
        let fd = this.foraDevices.find(fd=>fd.general.type === miioDevice.id)
        if (!fd) {
            const dps = Object.keys(deviceDPs).map(key=>{
                const deviceDP = deviceDPs[key]
                let dp = {
                    name: key,
                    config: {
                        isStatusable: !!deviceDP.event,
                        isControllable: !!deviceDP.action,
                        type: deviceDP.type
                    }
                }

                if (typeConverter[dp.config.type]) {
                    dp.config = {...dp.config, ...typeConverter[dp.config.type]}
                }
                dp.config.type = dp.config.type || "String"
                return dp
            })

            this.registerForaDevice({
                 appId: config.appId, 
                 config: {                    
                 }, 
                 general: {
                     type: miioDevice.id,
                     name: miioDevice.miioModel ? miioDevice.miioModel : "Unknown"
                 },
                 datapoints: dps
            })
        } else {
            if (fd.isRegistering) {
                console.log("Ignoring... Waiting to be registered")
            }
            // TODO: check datapoints exist
            //this.check
        }

        
        
    }

    async readForaDevices() {
        
        try {
            const result = await axios({
                method: 'GET',
                url: `${config.foraAPI}/api/v1/apps/${config.appId}/devices`, 
                headers: { 
                    'Authorization': `Bearer ${config.appToken}`
                }
            });
            //console.log("DEVICES configured: ", result.data)
            this.foraDevices = []
            result.data.forEach((device)=>{
                this.foraDevices.push(device)
                device.datapoints.forEach(dp=>{
                    if (dp.config.isControllable) {
                        //console.log("***********************")
                        //console.log(device.general.type, dp.name)
                        const topic = `dps/${dp._id}/control`;
                        this.subscibedTopics.push({
                            topic,
                            miioDevice: device.general.type,
                            action: "set" + upperFirst(dp.name)
                        })
                        this.client.subscribe(topic)
                        //console.log("***********************")
                    }
                })
                //subscibedTopics
            })
            
            // OK. We know now what is configured globally, lets read local
            this.connectToMiio()
        
        } catch (error) {
            console.log(`${config.foraAPI}/api/v1/apps/${config.appId}/devices`, error.message)
        }    
    }

    
    async log(message, level) {
        if (this.mqttConnected) {
            await this.client.publish(this.logTopic, message)
        } else {
            console.log("Not connected log: ", message)
        }
    }

    onForaConnected() {
        this.mqttConnected = true;
        console.log("Connected to Fora")
        this.log('MQTT is connected')
        this.client.publish(`apps/${config.appId}/online`, "true", {retain: true})
        this.client.subscribe(this.commandTopic)
        this.client.subscribe(this.notifyTopic)
        this.log('Subscribed to command topic: '+ this.commandTopic)
    }
    
    onForaError(error) {
        console.log("MQTT ERROR: ", error);
    }
    
    onForaReconnect() {
        this.log('MQTT reconnect attempt')
    }

    onForaDisconnect() {
        this.mqttConnected = false;
        this.log('MQTT disconnected')
    }

    onForaOffline() {
        this.mqttConnected = false;
        this.log('MQTT is offline')
    }

    async readConfig() {
        try {
            const result = await axios({
                method: 'GET',
                url: `${config.foraAPI}/api/v1/apps/${config.appId}`, 
                headers: { 
                    'Authorization': `Bearer ${config.appToken}`
                }
            });
            //console.log(result.data)
            if (result.data.config && result.data.config.AccessTokens) {
                this.tokens = {};
                result.data.config.AccessTokens.forEach(t=>{
                    this.tokens[parseInt(t.deviceID)] = t.token;
                })
            }
            
            this.readForaDevices()
           
            //console.log(this.appParams)
        } catch (error) {
            console.log(error.message)
        }
    }

    async onForaMessage(topic, message) {

        //console.log(">>>>>>>>>>>>>FORA MESSAGE", topic, message.toString())
        if (topic === this.commandTopic) {
            //console.log("Command topic received")
        }
    
        if (topic === this.notifyTopic) {
            //console.log("Notify topic received")
            if (message.toString()==="reloadApplication") {
                this.readConfig()
            }   
        }

        let found = this.subscibedTopics.find(st=>st.topic===topic)
        //console.log("###############################",found)
        if (found) {
            // console.log("-----1*/*/*/*/------->", Object.keys(this.miioDevices))
            // console.log("-----2*/*/*/*/------->", found.miioDevice)
            // console.log("-----3*/*/*/*/------->",this.miioDevices[found.miioDevice])
            this.miioDevices[found.miioDevice][found.action](JSON.parse(message.toString()))
        }
       
    }

}





const app = new Application();
app.start()


