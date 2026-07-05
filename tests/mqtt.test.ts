import { handleMessage, TOPIC_PREFIX_SETTINGS, validateBrokerUrl } from '../app/mqtt'
import { getSettings, setSetting } from '../app/modbus'

jest.mock('../app/modbus')

test('validateMqttUrl', () => {
    expect(validateBrokerUrl('mqtt://localhost:1883')).toEqual(true)
    expect(validateBrokerUrl('mqtts://localhost:1883')).toEqual(true)
    expect(validateBrokerUrl('mqtt://localhost')).toEqual(true)
    expect(validateBrokerUrl('localhost:1883')).toEqual(false)
    expect(validateBrokerUrl('localhost')).toEqual(false)
})

describe('handleMessage', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    test('echoes the new setting value before the full settings re-read', async () => {
        ;(getSettings as jest.Mock).mockResolvedValue({ temperatureTarget: 21 })
        const publishAsync = jest.fn().mockResolvedValue(undefined)
        const mqttClient = { publishAsync } as never
        const modbusClient = {} as never

        await handleMessage(
            modbusClient,
            mqttClient,
            `${TOPIC_PREFIX_SETTINGS}/temperatureTarget/set`,
            Buffer.from('21.5')
        )

        expect(setSetting).toHaveBeenCalledWith(modbusClient, 'temperatureTarget', '21.5')
        // First publish is the optimistic echo of exactly what was written...
        expect(publishAsync).toHaveBeenNthCalledWith(1, `${TOPIC_PREFIX_SETTINGS}/temperatureTarget`, '21.5', {})
        // ...and the reconciling publish (from the re-read) comes afterwards.
        expect(publishAsync).toHaveBeenCalledWith(`${TOPIC_PREFIX_SETTINGS}/temperatureTarget`, '21', {})
    })

    test('echoes ON/OFF for coil (switch) settings', async () => {
        ;(getSettings as jest.Mock).mockResolvedValue({ cookerHood: true })
        const publishAsync = jest.fn().mockResolvedValue(undefined)
        const mqttClient = { publishAsync } as never
        const modbusClient = {} as never

        await handleMessage(modbusClient, mqttClient, `${TOPIC_PREFIX_SETTINGS}/cookerHood/set`, Buffer.from('ON'))

        expect(setSetting).toHaveBeenCalledWith(modbusClient, 'cookerHood', true)
        expect(publishAsync).toHaveBeenNthCalledWith(1, `${TOPIC_PREFIX_SETTINGS}/cookerHood`, 'ON', {})
    })

    test('still echoes the value even if the reconciling re-read fails', async () => {
        ;(getSettings as jest.Mock).mockRejectedValue(new Error('Modbus timeout'))
        const publishAsync = jest.fn().mockResolvedValue(undefined)
        const mqttClient = { publishAsync } as never
        const modbusClient = {} as never

        await expect(
            handleMessage(modbusClient, mqttClient, `${TOPIC_PREFIX_SETTINGS}/temperatureTarget/set`, Buffer.from('22'))
        ).rejects.toThrow('Modbus timeout')

        // The echo happened before the failing re-read, so Home Assistant still gets the update.
        expect(publishAsync).toHaveBeenCalledWith(`${TOPIC_PREFIX_SETTINGS}/temperatureTarget`, '22', {})
    })
})
