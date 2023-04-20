from flask import Blueprint, render_template, request, flash, jsonify, Markup, url_for
from flask_login import login_required, current_user
from .models import Note
from . import db
import json
import folium

views = Blueprint('views', __name__)


@views.route('/', methods=['GET', 'POST'])
@login_required
def home():
    if request.method == 'POST': 
        note = request.form.get('note')#Gets the note from the HTML 

        if len(note) < 1:
            flash('Note is too short!', category='error') 
        else:
            new_note = Note(data=note, user_id=current_user.id)  #providing the schema for the note 
            db.session.add(new_note) #adding the note to the database 
            db.session.commit()
            flash('Note added!', category='success')

    return render_template("home.html", user=current_user)


@views.route('/delete-note', methods=['POST'])
def delete_note():  
    note = json.loads(request.data) # this function expects a JSON from the INDEX.js file 
    noteId = note['noteId']
    note = Note.query.get(noteId)
    if note:
        if note.user_id == current_user.id:
            db.session.delete(note)
            db.session.commit()

    return jsonify({})

@views.route('/the_secret_page', methods=['GET'])
def the_secret_page():
    tel_aviv_coords = (32.0853, 34.7818)
    map = folium.Map(location=tel_aviv_coords, zoom_start=13)

    login_url = url_for('auth.login')
    popup_text = f'<a href="{login_url}" target="_parent">Go to Login Page</a>'
    popup = folium.Popup(popup_text, max_width=300)
    tooltip = folium.Tooltip("Tel Aviv", permanent=False)
    folium.Marker(tel_aviv_coords, popup=popup, tooltip=tooltip).add_to(map)

    # Render the map as HTML and pass it to the template
    map_html = map._repr_html_()
    return render_template("the_secret_page.html", user=current_user, map=Markup(map_html))