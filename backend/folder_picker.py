"""Native folder picker helpers for CodePilot workspaces.

Windows uses the Vista+ ``IFileOpenDialog`` (Explorer-style) instead of the
legacy WinForms ``FolderBrowserDialog`` tree view. Other platforms fall back to
tkinter.
"""

from __future__ import annotations

import sys
from ctypes import (
    HRESULT,
    POINTER,
    Structure,
    WINFUNCTYPE,
    byref,
    c_byte,
    c_uint32,
    c_ulong,
    c_ushort,
    c_void_p,
    c_wchar_p,
    cast,
    windll,
)
from ctypes.wintypes import DWORD, HWND, LPCWSTR
from typing import Optional


class GUID(Structure):
    _fields_ = [
        ("Data1", c_ulong),
        ("Data2", c_ushort),
        ("Data3", c_ushort),
        ("Data4", c_byte * 8),
    ]

    def __init__(self, guid_string: str = "{00000000-0000-0000-0000-000000000000}"):
        super().__init__()
        if windll.ole32.CLSIDFromString(LPCWSTR(guid_string), byref(self)) != 0:
            raise OSError("invalid GUID: %s" % guid_string)


def _method(obj: c_void_p, index: int, *argtypes, restype=HRESULT):
    vtable = cast(cast(obj, POINTER(c_void_p)).contents, POINTER(c_void_p))
    return cast(vtable[index], WINFUNCTYPE(restype, c_void_p, *argtypes))


def _foreground_owner() -> HWND:
    """Return the HWND of the window that currently owns keyboard focus.

    When the user clicks the folder button the foreground window is the
    browser, so passing it as the dialog owner makes IFileOpenDialog appear on
    top of (and modal to) that window immediately — instead of a background,
    owner-less dialog being demoted behind the browser where a second click
    is required.  Returns 0 when the call is unavailable.
    """
    try:
        value = cast(windll.user32.GetForegroundWindow(), HWND)
        return value if value.value else HWND(0)
    except Exception:
        return HWND(0)


def pick_folder(title: str = "选择 CodePilot 工作区", initial_directory: Optional[str] = None) -> Optional[str]:
    """Open a native folder dialog and return the selected absolute path.

    Returns ``None`` when the user cancels.
    """
    owner = _foreground_owner()
    if sys.platform.startswith("win"):
        try:
            return _pick_folder_windows(title, initial_directory, owner)
        except Exception:
            # Keep the agent usable even if COM registration quirks appear on
            # unusual Windows installs; tkinter is still better than a prompt.
            return _pick_folder_tk(title, initial_directory)
    return _pick_folder_tk(title, initial_directory)


def _pick_folder_tk(title: str, initial_directory: Optional[str]) -> Optional[str]:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except tk.TclError:
        pass
    selected = filedialog.askdirectory(title=title, initialdir=initial_directory or None) or ""
    root.destroy()
    return selected or None


def _pick_folder_windows(title: str, initial_directory: Optional[str], owner: Optional[HWND] = None) -> Optional[str]:
    """Show the modern Explorer folder picker via IFileOpenDialog."""
    ole32 = windll.ole32
    shell32 = windll.shell32
    ole32.CoTaskMemFree.argtypes = [c_void_p]
    ole32.CoTaskMemFree.restype = None
    shell32.SHCreateItemFromParsingName.argtypes = [LPCWSTR, c_void_p, POINTER(GUID), POINTER(c_void_p)]
    shell32.SHCreateItemFromParsingName.restype = HRESULT

    COINIT_APARTMENTTHREADED = 0x2
    CLSCTX_INPROC_SERVER = 0x1
    FOS_PICKFOLDERS = 0x20
    FOS_FORCEFILESYSTEM = 0x40
    FOS_PATHMUSTEXIST = 0x800
    SIGDN_FILESYSPATH = 0x80058000

    clsid_file_open = GUID("{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}")
    iid_ifile_dialog = GUID("{42F85136-DB7E-439C-85F1-E4075D135FC8}")
    iid_ishell_item = GUID("{43826D1E-E718-42EE-BC55-A1E261C37BFE}")

    hr = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
    # S_OK (0) or S_FALSE (1) both mean COM is usable on this thread.
    if hr not in (0, 1):
        raise OSError("CoInitializeEx failed: 0x%08x" % (hr & 0xFFFFFFFF))

    dialog = c_void_p()
    try:
        hr = ole32.CoCreateInstance(
            byref(clsid_file_open),
            None,
            CLSCTX_INPROC_SERVER,
            byref(iid_ifile_dialog),
            byref(dialog),
        )
        if hr != 0 or not dialog.value:
            raise OSError("CoCreateInstance(FileOpenDialog) failed: 0x%08x" % (hr & 0xFFFFFFFF))

        options = c_uint32(0)
        hr = _method(dialog, 10, POINTER(c_uint32))(dialog, byref(options))  # GetOptions
        if hr != 0:
            raise OSError("IFileDialog::GetOptions failed")
        options.value |= FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
        hr = _method(dialog, 9, DWORD)(dialog, options)  # SetOptions
        if hr != 0:
            raise OSError("IFileDialog::SetOptions failed")

        if title:
            hr = _method(dialog, 17, LPCWSTR)(dialog, title)  # SetTitle
            if hr != 0:
                raise OSError("IFileDialog::SetTitle failed")

        if initial_directory:
            shell_item = c_void_p()
            hr = shell32.SHCreateItemFromParsingName(
                initial_directory,
                None,
                byref(iid_ishell_item),
                byref(shell_item),
            )
            if hr == 0 and shell_item.value:
                _method(dialog, 12, c_void_p)(dialog, shell_item)  # SetFolder
                _method(shell_item, 2)(shell_item)  # Release

        # Owner-modal over the browser window so the picker is brought to the
        # foreground and focused the moment it opens (no second click).  When
        # no usable owner exists the dialog is shown modeless and may appear
        # behind the foreground app.
        hr = _method(dialog, 3, HWND)(dialog, owner or HWND(0))  # Show
        if hr != 0:
            return None

        result_item = c_void_p()
        hr = _method(dialog, 20, POINTER(c_void_p))(dialog, byref(result_item))  # GetResult
        if hr != 0 or not result_item.value:
            return None

        path_ptr = c_wchar_p()
        try:
            hr = _method(result_item, 5, c_uint32, POINTER(c_wchar_p))(
                result_item,
                SIGDN_FILESYSPATH,
                byref(path_ptr),
            )  # GetDisplayName
            if hr != 0 or not path_ptr.value:
                return None
            return str(path_ptr.value)
        finally:
            if path_ptr:
                ole32.CoTaskMemFree(cast(path_ptr, c_void_p))
            _method(result_item, 2)(result_item)  # Release
    finally:
        if dialog.value:
            _method(dialog, 2)(dialog)  # Release
        ole32.CoUninitialize()
