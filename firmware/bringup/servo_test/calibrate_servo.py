import sys
import time
import threading
import serial
import serial.tools.list_ports

try:
    import msvcrt
except ImportError:
    msvcrt = None

PORT = "COM9"
BAUD = 115200

def list_ports():
    ports = serial.tools.list_ports.comports()
    return [p.device for p in ports]

def reader_thread(ser, stop_event):
    while not stop_event.is_set():
        try:
            if ser.in_waiting > 0:
                line = ser.readline()
                if line:
                    print(line.decode('utf-8', errors='replace'), end='', flush=True)
            else:
                time.sleep(0.01)
        except Exception:
            break

def safe_write(ser, data):
    try:
        ser.write(data)
        ser.flush()
    except Exception as e:
        print(f"\n[Write Error]: {e}")

def main():
    port = PORT
    available = list_ports()
    if port not in available and available:
        port = available[0]
        print(f"[!] Default port {PORT} not found, using {port}")

    print("=======================================================")
    print(f" TamperSafe Interactive Servo Calibrator (Port: {port})")
    print("=======================================================")
    print(" Controls:")
    print("   [UP / RIGHT ARROW]  : Increase angle (+1 / +5 deg)")
    print("   [DOWN / LEFT ARROW] : Decrease angle (-1 / -5 deg)")
    print("   [W / S / D / A]     : +1 / -1 / +5 / -5 deg")
    print("   [L]                 : Mark current angle as LOCK")
    print("   [U]                 : Mark current angle as UNLOCK")
    print("   [T]                 : Run test cycle (LOCK -> UNLOCK)")
    print("   [0 - 9] + Enter     : Jump directly to angle (e.g. 120)")
    print("   [Q] or [Ctrl+C]     : Exit")
    print("=======================================================\n")

    try:
        ser = serial.Serial()
        ser.port = port
        ser.baudrate = BAUD
        ser.timeout = 0.1
        ser.write_timeout = 2.0
        ser.dtr = True
        ser.rts = True
        ser.open()
        time.sleep(0.2)
        ser.reset_input_buffer()
        ser.reset_output_buffer()
    except Exception as e:
        print(f"Error opening port {port}: {e}")
        print("--> Make sure the Arduino IDE Serial Monitor is CLOSED before running this.")
        return

    stop_event = threading.Event()
    t = threading.Thread(target=reader_thread, args=(ser, stop_event), daemon=True)
    t.start()

    time.sleep(0.5)
    safe_write(ser, b"?\n") # Request banner / current status

    buffer = ""

    try:
        while True:
            if msvcrt and msvcrt.kbhit():
                ch = msvcrt.getch()
                if ch in (b'\x00', b'\xe0'): # Special key prefix (Arrow keys)
                    special = msvcrt.getch()
                    if special == b'H': # UP arrow
                        safe_write(ser, b'\x1b[A')
                    elif special == b'P': # DOWN arrow
                        safe_write(ser, b'\x1b[B')
                    elif special == b'M': # RIGHT arrow
                        safe_write(ser, b'\x1b[C')
                    elif special == b'K': # LEFT arrow
                        safe_write(ser, b'\x1b[D')
                elif ch == b'\x03' or ch == b'q' or ch == b'Q': # Ctrl+C or Q
                    print("\nExiting calibrator...")
                    break
                elif ch == b'\r' or ch == b'\n':
                    if buffer:
                        safe_write(ser, (buffer + "\n").encode())
                        buffer = ""
                    else:
                        safe_write(ser, b"\n")
                elif ch.isdigit():
                    buffer += ch.decode()
                    sys.stdout.write(ch.decode())
                    sys.stdout.flush()
                else:
                    char_str = ch.decode('utf-8', errors='ignore')
                    if char_str in ['l', 'L', 'u', 'U', 't', 'T', 'w', 'W', 's', 'S', 'a', 'A', 'd', 'D', '+', '-', '?']:
                        safe_write(ser, (char_str + "\n").encode())
                    elif ch == b'\x08': # Backspace
                        if buffer:
                            buffer = buffer[:-1]
                            sys.stdout.write('\b \b')
                            sys.stdout.flush()
            time.sleep(0.01)
    except KeyboardInterrupt:
        print("\nExiting calibrator...")
    finally:
        stop_event.set()
        try:
            ser.close()
        except Exception:
            pass

if __name__ == "__main__":
    main()
