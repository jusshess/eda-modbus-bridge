import { validateDevice, parseDevice, ModbusDeviceType, setSetting, getDeviceStatuses } from '../app/modbus'
import ModbusRTU from 'modbus-serial'

test('validateDevice', () => {
    expect(validateDevice('/dev/ttyUSB0')).toEqual(true)
    expect(validateDevice('dev/ttyUSB0')).toEqual(false)
    expect(validateDevice('tcp://192.168.1.40:502')).toEqual(true)
    expect(validateDevice('192.168.1.40:502')).toEqual(false)
})

test('parseDevice', () => {
    expect(parseDevice('/dev/ttyUSB0')).toEqual({
        type: ModbusDeviceType.RTU,
        path: '/dev/ttyUSB0',
    })
    expect(parseDevice('tcp://localhost:502')).toEqual({
        type: ModbusDeviceType.TCP,
        hostname: 'localhost',
        port: 502,
    })
    expect(parseDevice('tcp://127.0.0.1:502')).toEqual({
        type: ModbusDeviceType.TCP,
        hostname: '127.0.0.1',
        port: 502,
    })
})

describe('setSetting', () => {
    let mockClient: ModbusRTU

    beforeEach(() => {
        mockClient = {
            writeRegister: jest.fn().mockResolvedValue(undefined),
            writeRegisters: jest.fn().mockResolvedValue(undefined),
            writeCoil: jest.fn().mockResolvedValue(undefined),
        } as any
    })

    describe('holding register settings (numeric)', () => {
        test('should accept string values for numeric settings', async () => {
            await setSetting(mockClient, 'temperatureTarget', '22.5')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(135, 225) // 22.5 * 10
        })

        test('should parse and round decimal values correctly', async () => {
            await setSetting(mockClient, 'temperatureTarget', '22.0')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(135, 220)

            await setSetting(mockClient, 'temperatureTarget', '18.75')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(135, 188) // rounds to 18.8 * 10

            await setSetting(mockClient, 'temperatureTarget', '18.74')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(135, 187) // rounds to 18.7 * 10
        })

        test('should parse integer strings for settings without decimals', async () => {
            await setSetting(mockClient, 'awayVentilationLevel', '50')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(100, 50)

            await setSetting(mockClient, 'overPressureDelay', '30')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(57, 30)
        })

        test('should truncate decimals for integer-only settings', async () => {
            await setSetting(mockClient, 'awayVentilationLevel', '50.5')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(100, 50) // truncates to 50
        })

        test('should reject boolean values for numeric settings', async () => {
            await expect(setSetting(mockClient, 'temperatureTarget', true)).rejects.toThrow(
                'Setting "temperatureTarget" expects a numeric value, got boolean'
            )
        })

        test('should apply registerScale when set', async () => {
            await setSetting(mockClient, 'awayTemperatureReduction', '5')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(101, 50) // 5 * 10
        })

        test('should not scale when registerScale is not set', async () => {
            await setSetting(mockClient, 'awayVentilationLevel', '75')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(100, 75) // no scaling
        })

        test('should enforce min/max validation', async () => {
            await expect(setSetting(mockClient, 'temperatureTarget', '5')).rejects.toThrow('value 5 below minimum 10')
            await expect(setSetting(mockClient, 'temperatureTarget', '35')).rejects.toThrow('value 35 above maximum 30')
        })

        test('should allow values within min/max range', async () => {
            await setSetting(mockClient, 'temperatureTarget', '20')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(135, 200) // 20 * 10
        })

        test('should accept boundary values for min/max', async () => {
            await setSetting(mockClient, 'temperatureTarget', '10')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(135, 100) // 10 * 10

            await setSetting(mockClient, 'temperatureTarget', '30')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(135, 300) // 30 * 10
        })

        test('should handle settings without min/max', async () => {
            await setSetting(mockClient, 'temperatureControlMode', '2')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(136, 2) // no validation, no scaling
        })

        test('should write fan level settings', async () => {
            // ventilationLevel (reg 53) must use write-multiple (FC16) — the unit
            // ignores it as a single-register (FC6) write.
            await setSetting(mockClient, 'ventilationLevel', '60')
            expect(mockClient.writeRegisters).toHaveBeenCalledWith(53, [60])
            expect(mockClient.writeRegister).not.toHaveBeenCalledWith(53, 60)
            // Must not touch reg 54 (supplyFanOverPressure) — unlike the old
            // native modbus, which wrote [value, 0] and zeroed it.
            expect(mockClient.writeRegister).not.toHaveBeenCalledWith(54, expect.anything())
            expect(mockClient.writeRegisters).not.toHaveBeenCalledWith(53, [60, 0])

            await setSetting(mockClient, 'supplyFanBaseSpeed', '34')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(51, 34)

            await setSetting(mockClient, 'exhaustFanBaseSpeed', '35')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(52, 35)
        })

        test('should enforce the fan level minimum of 20', async () => {
            await expect(setSetting(mockClient, 'ventilationLevel', '10')).rejects.toThrow('value 10 below minimum 20')

            await setSetting(mockClient, 'ventilationLevel', '20')
            expect(mockClient.writeRegisters).toHaveBeenCalledWith(53, [20])
        })

        test('should write per-function fan speeds', async () => {
            await setSetting(mockClient, 'cookerHoodSupplyFanSpeed', '45')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(58, 45)

            await setSetting(mockClient, 'cookerHoodExhaustFanSpeed', '25')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(59, 25)

            await setSetting(mockClient, 'centralVacuumSupplyFanSpeed', '50')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(60, 50)

            await setSetting(mockClient, 'centralVacuumExhaustFanSpeed', '30')
            expect(mockClient.writeRegister).toHaveBeenCalledWith(61, 30)
        })
    })

    describe('coil settings (boolean)', () => {
        test('should accept boolean values for coil settings', async () => {
            await setSetting(mockClient, 'coolingAllowed', true)
            expect(mockClient.writeCoil).toHaveBeenCalledWith(52, true)

            await setSetting(mockClient, 'heatingAllowed', false)
            expect(mockClient.writeCoil).toHaveBeenCalledWith(54, false)
        })

        test('should write auxiliary function coils', async () => {
            await setSetting(mockClient, 'cookerHood', true)
            expect(mockClient.writeCoil).toHaveBeenCalledWith(4, true)

            await setSetting(mockClient, 'centralVacuumCleaner', true)
            expect(mockClient.writeCoil).toHaveBeenCalledWith(5, true)
        })

        test('should reject string values for coil settings', async () => {
            await expect(setSetting(mockClient, 'coolingAllowed', '1')).rejects.toThrow(
                'Setting "coolingAllowed" expects a boolean value, got string'
            )
        })
    })

    describe('unknown settings', () => {
        test('should reject unknown setting names', async () => {
            await expect(setSetting(mockClient, 'nonExistentSetting', '123')).rejects.toThrow(
                'Unknown setting "nonExistentSetting"'
            )
        })
    })
})

describe('getDeviceStatuses', () => {
    test('maps status coils to named booleans', async () => {
        const mockClient = {
            readCoils: jest
                .fn()
                // Coils 26-35 (index 7 = coil 33 is intentionally skipped)
                .mockResolvedValueOnce({ data: [true, false, true, false, true, false, true, false, false, true] })
                // Coils 41-46 (indices 3/4 = coils 44/45 skipped)
                .mockResolvedValueOnce({ data: [true, false, true, false, false, true] })
                // Coil 50
                .mockResolvedValueOnce({ data: [true] }),
        } as any

        const statuses = await getDeviceStatuses(mockClient)

        expect(statuses).toEqual({
            pressureGuard: true,
            coolingError: false,
            coolingRunning: true,
            heatRecoveryError: false,
            heatRecoveryRunning: true,
            heatingError: false,
            heatingRunning: true,
            externalHeatingDisabled: false,
            externalCoolingDisabled: true,
            alarmA: true,
            alarmB: false,
            clockProgramActive: true,
            externalUnitDefrosting: true,
            freezingRisk: true,
        })
    })

    test('skips a block that fails to read instead of throwing', async () => {
        const mockClient = {
            readCoils: jest
                .fn()
                .mockRejectedValueOnce(new Error('timeout')) // Coils 26-35 unsupported
                .mockResolvedValueOnce({ data: [false, false, false, false, false, false] }) // Coils 41-46
                .mockResolvedValueOnce({ data: [false] }), // Coil 50
        } as any

        const statuses = await getDeviceStatuses(mockClient)

        expect(statuses).not.toHaveProperty('coolingRunning')
        expect(statuses).toMatchObject({ alarmA: false, freezingRisk: false })
    })
})
