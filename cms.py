import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox, filedialog
import json
import subprocess
import os
import sys

# Ensure we can run node commands
def get_node_path():
    # Assuming node is in path, otherwise might need specific handling
    return "node"

class ProjectCMS:
    def __init__(self, root):
        self.root = root
        self.root.title("Latent Archive CMS")
        self.root.geometry("1200x800")
        
        # Data store
        self.projects = []
        self.current_index = -1
        
        # Styles
        style = ttk.Style()
        style.theme_use('clam')
        style.configure("TLabel", foreground="#333", font=("Arial", 10))
        style.configure("TButton", padding=5)
        
        self.setup_ui()
        self.load_data()

    def setup_ui(self):
        # Main Layout: Left List, Right Editor
        paned = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        
        # --- Left Panel: List ---
        left_frame = ttk.Frame(paned)
        paned.add(left_frame, weight=1)
        
        ttk.Label(left_frame, text="Projects", font=("Arial", 12, "bold")).pack(pady=5)
        
        list_scroll = ttk.Scrollbar(left_frame)
        list_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        
        self.project_list = tk.Listbox(left_frame, font=("Courier New", 10), selectmode=tk.SINGLE, yscrollcommand=list_scroll.set)
        self.project_list.pack(fill=tk.BOTH, expand=True)
        list_scroll.config(command=self.project_list.yview)
        
        self.project_list.bind('<<ListboxSelect>>', self.on_select)
        
        btn_frame = ttk.Frame(left_frame)
        btn_frame.pack(fill=tk.X, pady=5)
        ttk.Button(btn_frame, text="New Project", command=self.add_project).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=2)
        ttk.Button(btn_frame, text="Delete", command=self.delete_project).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=2)
        
        # --- Right Panel: Editor ---
        right_frame = ttk.Frame(paned)
        paned.add(right_frame, weight=3)
        
        # Scrollable editor area
        canvas = tk.Canvas(right_frame)
        scrollbar = ttk.Scrollbar(right_frame, orient="vertical", command=canvas.yview)
        scrollable_frame = ttk.Frame(canvas)
        
        scrollable_frame.bind(
            "<Configure>",
            lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )
        
        canvas.create_window((0, 0), window=scrollable_frame, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        
        # Fields
        self.fields = {}
        fields_config = [
            ("id", "ID (e.g., 001)"),
            ("name", "Name"),
            ("img", "Image Path"),
            ("desc", "Short Description"),
            ("dream", "Dream Text")
        ]
        
        for key, label in fields_config:
            f_frame = ttk.Frame(scrollable_frame)
            f_frame.pack(fill=tk.X, padx=10, pady=5)
            ttk.Label(f_frame, text=label).pack(anchor="w")
            entry = ttk.Entry(f_frame)
            entry.pack(fill=tk.X)
            self.fields[key] = entry
            
        # Full HTML Content
        f_frame = ttk.Frame(scrollable_frame)
        f_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        ttk.Label(f_frame, text="Full Content (HTML allowed)").pack(anchor="w")
        self.full_text = scrolledtext.ScrolledText(f_frame, height=15, font=("Courier New", 10))
        self.full_text.pack(fill=tk.BOTH, expand=True)
        
        # Toolbar
        toolbar = ttk.Frame(right_frame)
        toolbar.pack(fill=tk.X, pady=10)
        ttk.Button(toolbar, text="Save All Changes", command=self.save_data).pack(side=tk.RIGHT, padx=10)

    def load_data(self):
        try:
            # Use Node.js to parse the JS file and output JSON
            # We create a temporary script to import the module and print DATA
            cmd = [
                "node",
                "-e",
                "import('./projects.js').then(m => console.log(JSON.stringify(m.DATA))).catch(e => console.error(e))"
            ]
            # Capture output
            result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
            
            if result.returncode != 0:
                raise Exception(f"Node error: {result.stderr}")
            
            self.projects = json.loads(result.stdout)
            self.refresh_list()
            
        except Exception as e:
            messagebox.showerror("Error Loading Data", str(e))
            # Fallback empty
            self.projects = []

    def refresh_list(self):
        self.project_list.delete(0, tk.END)
        for p in self.projects:
            self.project_list.insert(tk.END, f"{p.get('id', '???')} - {p.get('name', 'Untitled')}")       

    def on_select(self, event):
        selection = self.project_list.curselection()
        if not selection:
            return
        
        # Save current if editing? (Simpler to just load for now, save is manual)
        self.current_index = selection[0]
        data = self.projects[self.current_index]
        
        for key, entry in self.fields.items():
            entry.delete(0, tk.END)
            entry.insert(0, data.get(key, ""))
            
        self.full_text.delete("1.0", tk.END)
        self.full_text.insert("1.0", data.get("full", ""))

    def update_current_from_ui(self):
        if self.current_index < 0 or self.current_index >= len(self.projects):
            return
        
        p = self.projects[self.current_index]
        for key, entry in self.fields.items():
            p[key] = entry.get()
        p["full"] = self.full_text.get("1.0", tk.END).strip()

    def add_project(self):
        new_p = {
            "id": f"{len(self.projects)+1:03d}",
            "name": "NEW PROJECT",
            "img": "data/images/placeholder.png",
            "desc": "Description here",
            "dream": "Dream text here",
            "full": "<p>Content</p>"
        }
        self.projects.append(new_p)
        self.refresh_list()
        self.project_list.selection_set(tk.END)
        self.on_select(None)

    def delete_project(self):
        if self.current_index < 0:
            return
        if messagebox.askyesno("Confirm", "Delete this project?"):
            self.projects.pop(self.current_index)
            self.current_index = -1
            self.refresh_list()
            # Clear inputs
            for entry in self.fields.values():
                entry.delete(0, tk.END)
            self.full_text.delete("1.0", tk.END)

    def save_data(self):
        # Update current in memory first
        self.update_current_from_ui()
        
        try:
            # Generate the JS file content
            js_content = "export const DATA = [\n"
            
            for p in self.projects:
                js_content += "    { \n"
                js_content += f"        id: '{p.get('id', '')}', \n"
                
                # Escape double quotes for JSON-like string values
                name_val = p.get('name', '').replace('"', '\"')
                js_content += f"        name: \"{name_val}\", \n"
                
                js_content += f"        img: '{p.get('img', '')}', \n"
                
                desc_val = p.get('desc', '').replace('"', '\"')
                js_content += f"        desc: \"{desc_val}\", \n"
                
                dream_val = p.get('dream', '').replace('"', '\"')
                js_content += f"        dream: \"{dream_val}\", \n"

                # Handle full content with backticks
                full_content = p.get('full', '').replace('`', '\`')
                js_content += f"        full: `{full_content}` \n"
                js_content += "    },\n"
            
            js_content += "];"
            
            with open("projects.js", "w", encoding="utf-8") as f:
                f.write(js_content)
                
            messagebox.showinfo("Success", "projects.js saved successfully!")
            
        except Exception as e:
            messagebox.showerror("Error Saving", str(e))

if __name__ == "__main__":
    root = tk.Tk()
    app = ProjectCMS(root)
    root.mainloop()