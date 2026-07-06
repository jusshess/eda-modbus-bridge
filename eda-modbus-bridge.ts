import express from 'express'
import expressWinston from 'express-winston'
import mqtt, { MqttClient } from 'mqtt'
import yargs from 'yargs'
import ModbusRTU from 'modbus-serial'
import { configureRoutes } from './app/http'
import {
    handleMessage,
    publishDeviceInformation,
    publishValues,
    subscribeToChanges,
    validateBrokerUrl,
} from './app/mqtt.js'
import { configureMqttDiscovery } from './app/homeassistant'
import { createLogger, setLogLevel } from './app/logger'
import { openModbusConnection, parseDevice, reconnectModbus, validateDevice } from './app/modbus'
import { setIntervalAsync } from 'set-interval-async'
import { ErrorHandler } from './app/error'

const MQTT_INITIAL_RECONNECT_RETRY_INTERVAL_SECONDS = 5
const MAX_SUBSEQUENT_ERRORS = 10

const logger = createLogger('main')

const argv = yargs(process.argv.slice(2))
    .usage('node $0 [options]')
    .options({
        'device': {
            description:
                'The Modbus device to use, e.g. /dev/ttyUSB0 for Modbus RTU or tcp://192.168.1.40:502 for Modbus TCP',
            type: 'string',
            demandOption: true,
            alias: 'd',
        },
        'modbusSlave': {
            description: 'The Modbus slave address',
            type: 'number',
            default: 1,
            alias: 's',
        },
        'modbusTimeout': {
            description: 'The timeout for Modbus operations (in seconds)',
            type: 'number',
            default: 5,
            alias: 't',
        },
        'http': {
            description: 'Whether to enable the HTTP server or not',
            type: 'boolean',
            default: true,
        },
        'httpListenAddress': {
            description: 'The address to listen (HTTP)',
            type: 'string',
            default: '0.0.0.0',
            alias: 'a',
        },
        'httpPort': {
            description: 'The port to listen on (HTTP)',
            type: 'number',
            default: 8080,
            alias: 'p',
        },
        'mqttBrokerUrl': {
            description: 'The URL to the MQTT broker, e.g. mqtt://localhost:1883. Omit to disable MQTT support.',
            type: 'string',
            default: undefined,
            alias: 'm',
        },
        'mqttUsername': {
            description: 'The username to use when connecting to the MQTT broker. Omit to disable authentication.',
            default: undefined,
        },
        'mqttPassword': {
            description:
                'The password to use when connecting to the MQTT broker. Required when mqttUsername is defined. Omit to disable authentication.',
            default: undefined,
        },
        'mqttPublishInterval': {
            description: 'How often messages should be published over MQTT (in seconds)',
            default: 10,
            alias: 'i',
        },
        'mqttDiscovery': {
            description:
                'Whether to enable Home Assistant MQTT discovery support. Only effective when mqttBrokerUrl is defined.',
            type: 'boolean',
            default: true,
        },
        'debug': {
            description: 'Enable debug logging',
            type: 'boolean',
            default: false,
            alias: 'v',
        },
    })
    .parserConfiguration({
        // Protect against weird things happening if someone accidentally uses "-option" instead of "--option"
        'short-option-groups': false,
        'duplicate-arguments-array': false,
    })
    .parseSync()

void (async () => {
    // Adjust log level
    if (argv.debug) {
        setLogLevel(logger, 'debug')
    }

    // Create Modbus client. Abort if a malformed device is specified.
    if (!validateDevice(argv.device)) {
        logger.error(`Malformed Modbus device ${argv.device} specified, exiting`)
        process.exit(1)
    }
    logger.info(
        `Opening Modbus connection to ${argv.device}, slave ID ${argv.modbusSlave}, ${argv.modbusTimeout} second timeout`
    )
    const modbusDevice = parseDevice(argv.device)
    const modbusClient = new ModbusRTU()
    await openModbusConnection(modbusClient, modbusDevice, argv.modbusSlave, argv.modbusTimeout * 1000)

    // Optionally create HTTP server
    if (argv.http) {
        // Create component-specific logger
        const httpLogger = createLogger('http')

        // Define middleware
        const httpServer = express()
        httpServer.use(expressWinston.logger({ winstonInstance: httpLogger }))
        httpServer.use(express.json())

        // Define routes
        configureRoutes(httpServer, modbusClient)

        httpServer.listen(argv.httpPort, argv.httpListenAddress, () => {
            httpLogger.info(`Listening on http://${argv.httpListenAddress}:${argv.httpPort}`)
        })
    }

    // Optionally create MQTT client
    if (argv.mqttBrokerUrl !== undefined) {
        if (!validateBrokerUrl(argv.mqttBrokerUrl)) {
            logger.error(`Malformed MQTT broker URL: ${argv.mqttBrokerUrl}. Should be e.g. mqtt://localhost:1883.`)
        } else {
            logger.info(`Connecting to MQTT broker at ${argv.mqttBrokerUrl}`)

            // Handle authentication
            let clientOptions = {}

            if (argv.mqttUsername && argv.mqttPassword) {
                logger.info('Using MQTT broker authentication')

                clientOptions = {
                    'username': argv.mqttUsername,
                    'password': argv.mqttPassword,
                }
            }

            // The MQTT client handles reconnections automatically, but only after it has connected successfully once.
            // Retry manually until we get an initial connection.
            let mqttClient: MqttClient
            let connectedOnce = false
            const retryIntervalMs = MQTT_INITIAL_RECONNECT_RETRY_INTERVAL_SECONDS * 1000

            do {
                try {
                    mqttClient = await mqtt.connectAsync(argv.mqttBrokerUrl, clientOptions)
                    connectedOnce = true
                    logger.info(`Successfully connected to MQTT broker at ${argv.mqttBrokerUrl}`)
                } catch (e) {
                    const err = e as Error
                    logger.error(
                        `Failed to connect to MQTT broker: ${err.message}. Retrying in ${retryIntervalMs} milliseconds`
                    )

                    await new Promise((resolve) => setTimeout(resolve, retryIntervalMs))
                }
            } while (!connectedOnce)

            mqttClient = mqttClient!

            const errorHandler = new ErrorHandler(MAX_SUBSEQUENT_ERRORS)

            // Publish device information once only (since it doesn't change)
            await publishDeviceInformation(modbusClient, mqttClient)

            // Publish readings/settings/modes/alarms once immediately, then regularly according to the configured
            // interval.
            await publishValues(modbusClient, mqttClient)
            // Recover a wedged Modbus link (repeated timeouts keep failing until
            // reconnected) by reconnecting the port instead of letting the error
            // handler's re-throw escape as an unhandled rejection and crash the
            // process — systemd would just restart us and lose ~2 minutes to the
            // initial full register read. Never throws, so it is safe to await from
            // both the publish loop and the MQTT command handler, which share the
            // same error counter.
            const recoverFromModbusError = async (e: Error) => {
                try {
                    errorHandler.handleError(e)
                } catch {
                    logger.error('Too many consecutive Modbus errors, reconnecting Modbus...')
                    try {
                        await reconnectModbus(modbusClient, modbusDevice, argv.modbusSlave, argv.modbusTimeout * 1000)
                        logger.info('Modbus reconnected')
                    } catch (reconnectError) {
                        logger.error(`Modbus reconnect failed: ${(reconnectError as Error).message}`)
                    } finally {
                        // Reset either way so we tolerate another batch of errors
                        // before the next reconnect attempt.
                        errorHandler.resetCounter()
                    }
                }
            }

            setIntervalAsync(async () => {
                try {
                    await publishValues(modbusClient, mqttClient)
                    errorHandler.resetCounter()
                } catch (e) {
                    await recoverFromModbusError(e as Error)
                }
            }, argv.mqttPublishInterval * 1000)

            logger.info(`MQTT scheduler started, will publish readings every ${argv.mqttPublishInterval} seconds`)

            // Subscribe to changes and register a handler
            await subscribeToChanges(mqttClient)
            // eslint-disable-next-line @typescript-eslint/no-misused-promises
            mqttClient.on('message', async (topicName, payload) => {
                try {
                    await handleMessage(modbusClient, mqttClient, topicName, payload)
                    errorHandler.resetCounter()
                } catch (e) {
                    // Same wedged-bus recovery as the publish loop — an inbound
                    // command timing out must not crash the process either.
                    await recoverFromModbusError(e as Error)
                }
            })

            // Optionally configure Home Assistant MQTT discovery
            if (argv.mqttDiscovery) {
                await configureMqttDiscovery(modbusClient, mqttClient)
                logger.info('Finished configuration Home Assistant MQTT discovery')
            }

            // Log reconnection attempts
            mqttClient.on('reconnect', () => {
                logger.info(`Attempting to reconnect to ${argv.mqttBrokerUrl}`)
            })
        }
    }
})()
